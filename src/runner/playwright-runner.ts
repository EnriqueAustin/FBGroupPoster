/**
 * The Playwright runner.
 *
 * Assisted and auto mode share this entire file; auto differs only in that it
 * clicks Post itself. That is deliberate — when you eventually turn auto on,
 * it is not new, untested code driving your account.
 */
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PostJob, PostResult, Runner } from '../domain/contracts.ts';
import { FACEBOOK_HOME, firstPage, isLoggedIn, launchBrowser, profileDirFor, type RunnerBrowser } from './browser.ts';
import {
  detectBlock, isAccountWide, isWrongComposerMessage, WRONG_COMPOSER_TAG, type BlockResult,
} from './detect.ts';
import { composerFor, submitPost, waitForPageReady, ComposerError } from './composers.ts';
import { ensureIdentity } from './identity.ts';
import type { Identity } from '../domain/types.ts';

export interface RunnerOptions {
  projectRoot?: string;
  slowMoMs?: number;
  log?: (msg: string) => void;
  /** How long assisted mode waits for the human. Default 15 minutes. */
  humanTimeoutMs?: number;
  /**
   * How the human is asked to confirm a post. Defaults to stdin; the server
   * swaps in a version that asks through the UI. Context carries what is being
   * decided so a graphical caller can show it properly.
   */
  askHuman?: (prompt: string, context?: Record<string, unknown>) => Promise<string>;
  /**
   * Asked when the browser cannot be switched into a post's identity
   * automatically. Resolve true once the human has switched by hand. Defaults
   * to stdin.
   */
  askSwitch?: (identity: Identity) => Promise<boolean>;
  /**
   * Whose Chrome profile to open (see profileDirFor). Omitted = the personal
   * profile's, which is where every run went before Pages had their own.
   */
  identity?: Identity;
  /**
   * Asked when the profile opens signed out — the first run in a Page's own
   * profile always does. Resolve true once the human has signed in. Without
   * it, a signed-out profile ends the run before anything is attempted.
   */
  confirmSignIn?: () => Promise<boolean>;
}

const DIAGNOSTICS_DIR = path.join('data', 'media', 'diagnostics');

async function askOnStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/**
 * What the check BEFORE composing means. Null = carry on and compose.
 *
 * Every real kind is reported as 'blocked' with its kind attached; whether
 * that stops the run or just this group is the orchestrator's call, made from
 * the kind. The runner only reports what the page said.
 *
 * The exception is 'pending-approval': seen before we have posted anything,
 * it can only be a notice about an EARLIER post. That is not a reason to stop,
 * and the group's cooldown already covers how often it is posted to.
 */
export function resultBeforeComposing(before: BlockResult, log: (m: string) => void = () => {}): PostResult | null {
  if (!before.blocked) return null;
  if (before.kind === 'pending-approval') {
    log('    note: the group shows an earlier post still pending approval — carrying on');
    return null;
  }
  return {
    outcome: 'blocked',
    blockKind: before.kind,
    error: before.reason ?? 'Facebook pushed back',
    detail: `${before.kind ?? 'unknown'}${before.kind && !isAccountWide(before.kind) ? ' (group-level, not account-wide)' : ''}`,
  };
}

/**
 * What the check AFTER posting means (the human said they posted, or auto
 * mode's submit succeeded).
 *
 * "Your post is pending approval" is the normal result in groups that vet
 * posts, and it means the post WENT OUT. It must be 'posted' so the group's
 * cooldown starts; reporting it as a block used to trip the breaker and
 * requeue the item, and the group then got the same ad a second time.
 */
export function resultAfterPosting(after: BlockResult, fbPostUrl: string): PostResult {
  if (!after.blocked) return { outcome: 'posted', fbPostUrl };
  if (after.kind === 'pending-approval') {
    return { outcome: 'posted', fbPostUrl, detail: 'pending admin approval' };
  }
  return {
    outcome: 'blocked',
    blockKind: after.kind,
    error: after.reason ?? 'blocked after posting',
    detail: after.kind,
  };
}

/**
 * What a thrown error means. Always 'failed' — an exception is never a block;
 * blocks are only ever read off the page by detectBlock.
 *
 * Only the first line goes in `error`: messages can carry a long list of what
 * the page offered, which belongs in the diagnostics file, not a table cell.
 *
 * The buy-and-sell ComposerError is tagged (WRONG_COMPOSER_TAG) so the
 * orchestrator can tell "this group is misconfigured and will fail every
 * time" from a transient failure. The whole message is searched, not just the
 * first line, so the tag does not depend on where composers.ts puts its hint.
 */
export function resultFromError(message: string, screenshotPath?: string): PostResult {
  const firstLine = message.split('\n')[0] ?? message;
  if (isWrongComposerMessage(message)) {
    return { outcome: 'failed', error: `${WRONG_COMPOSER_TAG}: ${firstLine}`, detail: screenshotPath };
  }
  return { outcome: 'failed', error: firstLine, detail: screenshotPath };
}

export function createRunner(opts: RunnerOptions = {}): Runner {
  const log = opts.log ?? ((m: string) => console.log(m));
  const ask = opts.askHuman ?? askOnStdin;
  const askSwitch = opts.askSwitch ?? (async (identity: Identity) => (await askOnStdin(
    `  Switch the browser to ${identity.name} yourself (avatar menu, top right), then press Enter — or type q to give up: `,
  )) !== 'q');
  let browser: RunnerBrowser | null = null;
  /**
   * Page ids learned during this run, so a Page whose id was not yet stored
   * is verified by id from its second post on instead of switched again.
   */
  const learned = new Map<number, string>();

  async function screenshot(name: string): Promise<string | undefined> {
    if (!browser) return undefined;
    try {
      mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
      const file = path.join(DIAGNOSTICS_DIR, `${name}-${Date.now()}.png`);
      const page = await firstPage(browser.context);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return undefined;
    }
  }

  return {
    async start() {
      browser = await launchBrowser({
        profileDir: profileDirFor(opts.identity, opts.projectRoot), slowMoMs: opts.slowMoMs, log,
      });
      // Checked once, up front: a signed-out session would otherwise fail every
      // post in the run one by one, each looking like a broken composer.
      const page = await firstPage(browser.context);
      await page.goto(FACEBOOK_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (await isLoggedIn(page)) return;
      log(`Sign in to Facebook in the Chrome window${opts.identity ? ` for ${opts.identity.name}` : ''} — `
        + 'each identity has its own Chrome profile, so this is needed once per identity.');
      if (!opts.confirmSignIn || !(await opts.confirmSignIn())) {
        await browser.close();
        browser = null;
        throw new Error('run cancelled: the browser is not signed in to Facebook');
      }
    },

    async post(job: PostJob): Promise<PostResult> {
      if (!browser) throw new Error('runner.start() must be called before post()');
      const page = await firstPage(browser.context);
      let learnedFbPageId: string | undefined;

      try {
        // Become the right identity BEFORE opening the group. Not being able to
        // confirm it is a failure of this item, never a reason to post anyway.
        if (job.identity) {
          const known = learned.get(job.identity.id);
          const identity = known && !job.identity.fbPageId ? { ...job.identity, fbPageId: known } : job.identity;
          const sw = await ensureIdentity(browser.context, page, identity, { log, askHuman: askSwitch });
          if (!sw.ok) return { outcome: 'failed', error: sw.error };
          if (sw.learnedFbPageId) {
            learned.set(job.identity.id, sw.learnedFbPageId);
            learnedFbPageId = sw.learnedFbPageId;
          }
        }

        const withLearned = (r: PostResult): PostResult => (learnedFbPageId ? { ...r, learnedFbPageId } : r);
        return withLearned(await composeAndPost());
      } catch (err) {
        const stamp = `fail-group-${job.group.id}-${Date.now()}`;
        const shot = await screenshot(stamp);
        const message = err instanceof ComposerError ? err.message
          : err instanceof Error ? err.message : String(err);

        // Write the full text alongside the image. The message now carries a
        // list of what the page actually offers, which is too long to read in
        // a table cell but is exactly what fixing a selector needs.
        try {
          mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
          writeFileSync(path.join(DIAGNOSTICS_DIR, `${stamp}.txt`),
            `group: ${job.group.name}\nurl: ${job.group.url}\nad: ${job.ad.name}\n`
            + `as: ${job.identity?.name ?? '(not specified)'}\n\n${message}\n`);
        } catch { /* diagnostics are best-effort */ }

        log(`    FAILED: ${message}`);
        const failed = resultFromError(message, shot);
        return learnedFbPageId ? { ...failed, learnedFbPageId } : failed;
      }

      async function composeAndPost(): Promise<PostResult> {
        await page.goto(job.group.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

        // domcontentloaded fires while Facebook is still showing its splash
        // logo. Everything below reads the DOM, so wait for a real render
        // first — otherwise both the block check and the composer lookup run
        // against a spinner.
        log('    waiting for the group page to render…');
        await waitForPageReady(page, log);

        // Check BEFORE composing. If the account is already restricted there is
        // no point typing anything, and every extra attempt makes it worse.
        const refused = resultBeforeComposing(await detectBlock(page), log);
        if (refused) return refused;

        await composerFor(job.group.composerType)({ page, variant: job.variant, log });

        if (job.mode === 'assisted') {
          log('');
          log(`  READY TO POST — ${job.group.name}${job.identity ? ` (as ${job.identity.name})` : ''}`);
          if (job.group.rulesNotes.trim()) log(`  GROUP RULES: ${job.group.rulesNotes.trim()}`);
          log('  Review it in the browser, then post it yourself.');
          const answer = await ask('  [Enter] = I posted it   |   s = skip   |   q = stop the run: ', {
            groupName: job.group.name,
            groupUrl: job.group.url,
            postingAs: job.identity?.name ?? null,
            rulesNotes: job.group.rulesNotes,
            adName: job.ad.name,
            caption: job.variant.caption,
            images: job.variant.imagePaths.length,
          });

          if (answer === 's') return { outcome: 'skipped', detail: 'skipped by human' };
          if (answer === 'q') return { outcome: 'skipped', detail: 'run stopped by human' };

          // Trust the human's answer, but still check that acting on it did not
          // land us on a block screen.
          return resultAfterPosting(await detectBlock(page), page.url());
        }

        // --- auto mode ---
        // submitPost throws if it cannot find an enabled Post button, or if the
        // composer is still open afterwards. Both mean the post did NOT go out,
        // and both land in the catch below as 'failed' with a screenshot —
        // which is the point. Reporting a post that never happened is worse
        // than reporting a failure, because it starts the group's cooldown.
        log(`  AUTO — posting to ${job.group.name} without asking`);
        await submitPost(page, log);

        return resultAfterPosting(await detectBlock(page), page.url());
      }
    },

    async stop() {
      await browser?.close();
      browser = null;
    },
  };
}
