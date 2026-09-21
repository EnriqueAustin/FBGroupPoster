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
import { firstPage, launchBrowser, type RunnerBrowser } from './browser.ts';
import { detectBlock, isAccountWide, type BlockResult } from './detect.ts';
import { composerFor, submitPost, waitForPageReady, ComposerError } from './composers.ts';

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

export function createRunner(opts: RunnerOptions = {}): Runner {
  const log = opts.log ?? ((m: string) => console.log(m));
  const ask = opts.askHuman ?? askOnStdin;
  let browser: RunnerBrowser | null = null;

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
      browser = await launchBrowser({ projectRoot: opts.projectRoot, slowMoMs: opts.slowMoMs, log });
    },

    async post(job: PostJob): Promise<PostResult> {
      if (!browser) throw new Error('runner.start() must be called before post()');
      const page = await firstPage(browser.context);

      try {
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
          log(`  READY TO POST — ${job.group.name}`);
          if (job.group.rulesNotes.trim()) log(`  GROUP RULES: ${job.group.rulesNotes.trim()}`);
          log('  Review it in the browser, then post it yourself.');
          const answer = await ask('  [Enter] = I posted it   |   s = skip   |   q = stop the run: ', {
            groupName: job.group.name,
            groupUrl: job.group.url,
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
            `group: ${job.group.name}\nurl: ${job.group.url}\nad: ${job.ad.name}\n\n${message}\n`);
        } catch { /* diagnostics are best-effort */ }

        log(`    FAILED: ${message}`);
        return { outcome: 'failed', error: message.split('\n')[0], detail: shot };
      }
    },

    async stop() {
      await browser?.close();
      browser = null;
    },
  };
}
