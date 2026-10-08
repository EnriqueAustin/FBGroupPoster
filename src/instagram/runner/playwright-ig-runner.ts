/**
 * The Playwright side of the Instagram runner: the IgRunner contract, done
 * for real.
 *
 * Everything hard is in the modules this composes — auth.ts decides whether
 * we are signed in, detect.ts decides whether Instagram pushed back,
 * harvest/follow/dm drive the pages, parse.ts interprets what they read. This
 * file is the wiring: one browser, opened once per job, and the translation
 * from those modules' outcomes into the flat domain results the run loop is
 * written against.
 *
 * Assisted and auto mode share this entire file. Auto differs only in that
 * dm.ts presses Send itself rather than leaving it to the human.
 */
import type { Page } from 'playwright';
import { createInterface } from 'node:readline/promises';
import type {
  IgDmResult, IgFollowersResult, IgFollowResult, IgHarvestContext, IgHarvestResult,
  IgInboxEntry, IgInboxResult, IgRunner,
} from '../domain/contracts.ts';
import type { Id, IgCampaign, IgFilters, IgRunnerMode } from '../domain/types.ts';
import { firstPage, launchBrowser, type RunnerBrowser } from '../../core/browser.ts';
import { igProfileDir, isLoggedIn, login, ownHandle } from './auth.ts';
import { classifyReply, matchThreadToLeads, readInbox, readOwnFollowers } from './check.ts';
import { sendDm } from './dm.ts';
import { harvestSource } from './harvest.ts';
import { visitAndFollow } from './follow.ts';

export interface IgRunnerOptions {
  projectRoot?: string;
  slowMoMs?: number;
  log?: (msg: string) => void;
  mode?: IgRunnerMode;
  /**
   * How the human is asked to confirm a follow or a DM. Defaults to stdin;
   * the server swaps in a version that asks through the UI. Context carries
   * what is being decided so a graphical caller can show it properly.
   */
  askHuman?: (prompt: string, context?: Record<string, unknown>) => Promise<string>;
  /**
   * Asked when the Instagram profile opens signed out — the first run always
   * does. Resolve true once the human has signed in. Without it, a signed-out
   * profile ends the job before anything is attempted.
   */
  confirmSignIn?: () => Promise<boolean>;
  /** True once the human has asked the job to stop. */
  cancelled?: () => boolean;
}

async function askOnStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export function createIgRunner(opts: IgRunnerOptions = {}): IgRunner {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const ask = opts.askHuman ?? askOnStdin;
  const auto = opts.mode === 'auto';

  let browser: RunnerBrowser | null = null;
  let page: Page | null = null;
  /** Read once per job: the pre-filter needs it, and it does not change. */
  let myHandle: string | null = null;

  async function ensurePage(): Promise<Page> {
    if (page) return page;
    browser = await launchBrowser({
      projectRoot: opts.projectRoot,
      profileDir: igProfileDir(opts.projectRoot),
      slowMoMs: opts.slowMoMs,
      log,
    });
    page = await firstPage(browser.context);
    return page;
  }

  return {
    async start() {
      const p = await ensurePage();
      await p.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch(() => undefined);

      if (!(await isLoggedIn(p))) {
        log('  Instagram is not signed in in this browser profile.');
        // The server's version of this asks through the UI; on the command
        // line, waitForSignIn's own loop is the better experience.
        if (opts.confirmSignIn) {
          if (!(await opts.confirmSignIn())) return false;
        } else if (!(await login(browser!.context, { log }))) {
          return false;
        }
        if (!(await isLoggedIn(p))) {
          log('  still not signed in — nothing will be attempted.');
          return false;
        }
      }

      myHandle = await ownHandle(p);
      log(myHandle ? `  signed in as @${myHandle}` : '  signed in (own handle could not be read)');
      return true;
    },

    async follow(username: string, filters: IgFilters): Promise<IgFollowResult> {
      const p = await ensurePage();
      const result = await visitAndFollow(p, username, filters, {
        log,
        // Auto mode does not ask. Assisted mode asks before every follow.
        ...(auto ? {} : {
          confirm: async (question, context) => {
            const answer = await ask(question, context);
            return answer === '' ? 'y' : answer;
          },
        }),
      });

      switch (result.kind) {
        case 'followed': return { outcome: 'followed', followsUs: result.facts.followsUs };
        case 'already-following': return { outcome: 'already-following', followsUs: result.facts.followsUs };
        case 'skipped': return { outcome: 'skipped', reason: result.reason };
        case 'failed': return { outcome: 'failed', error: result.error };
        case 'blocked': return { outcome: 'blocked', reason: result.block.reason ?? 'Instagram pushed back' };
      }
    },

    async dm(username: string, text: string): Promise<IgDmResult> {
      const p = await ensurePage();
      const result = await sendDm(p, username, text, {
        log,
        auto,
        ...(auto ? {} : {
          confirm: async (question, context) => {
            const answer = await ask(question, context);
            return answer === '' ? 'y' : answer;
          },
        }),
      });

      switch (result.kind) {
        // Both mean the message is in the thread: auto confirmed it, or the
        // human said so. The distinction is not the run loop's business.
        case 'sent':
        case 'sent-by-human':
          return { outcome: 'sent' };
        case 'skipped': return { outcome: 'skipped', reason: result.reason };
        case 'failed': return { outcome: 'failed', error: result.error };
        case 'blocked': return { outcome: 'blocked', reason: result.block.reason ?? 'Instagram pushed back' };
      }
    },

    async harvest(campaign: IgCampaign, sourceHandle: string, ctx: IgHarvestContext): Promise<IgHarvestResult> {
      const p = await ensurePage();
      const report = await harvestSource(p, campaign, sourceHandle, {
        isKnown: ctx.isKnown,
        sourceHandles: campaign.sources,
        ownHandle: myHandle,
      }, { log, cancelled: opts.cancelled });

      const skipped: Record<string, number> = {};
      const people = [];
      const notes: string[] = [];
      for (const post of report.posts) {
        people.push(...post.people);
        for (const [reason, count] of Object.entries(post.skipped)) {
          skipped[reason] = (skipped[reason] ?? 0) + count;
        }
        if (post.likesUnavailable) {
          notes.push(`the likes list for ${post.shortcode} was unavailable; commenters were used instead`);
        }
      }
      if (report.note) notes.push(report.note);

      return {
        people,
        skipped,
        postsRead: report.posts.length,
        notes,
        ...(report.block ? { blocked: report.block.reason ?? 'Instagram pushed back' } : {}),
      };
    },

    async followers(): Promise<IgFollowersResult> {
      const p = await ensurePage();
      if (!myHandle) {
        return { outcome: 'failed', error: 'the signed-in account’s handle could not be read' };
      }
      const result = await readOwnFollowers(p, myHandle, { log, cancelled: opts.cancelled });
      switch (result.kind) {
        case 'ok': return { outcome: 'ok', followers: result.followers };
        case 'failed': return { outcome: 'failed', error: result.error };
        case 'blocked': return { outcome: 'blocked', reason: result.block.reason ?? 'Instagram pushed back' };
      }
    },

    async inbox(candidates): Promise<IgInboxResult> {
      const p = await ensurePage();
      const result = await readInbox(p, { log });
      if (result.kind === 'blocked') {
        return { outcome: 'blocked', reason: result.block.reason ?? 'Instagram pushed back' };
      }
      if (result.kind === 'failed') return { outcome: 'failed', error: result.error };

      const entries: IgInboxEntry[] = [];
      for (const thread of result.threads) {
        // Only threads with something new in them: an already-read thread was
        // either answered by the human or is the message we sent.
        if (!thread.unread) continue;
        const lead = matchThreadToLeads(thread, candidates as readonly { id: Id; username: string; displayName: string | null }[]);
        entries.push({
          leadId: lead?.id ?? null,
          title: lead?.username ?? thread.title,
          preview: thread.preview,
          unread: thread.unread,
          kind: classifyReply(thread.preview),
        });
      }
      return { outcome: 'ok', entries };
    },

    async stop() {
      await browser?.close();
      browser = null;
      page = null;
    },
  };
}
