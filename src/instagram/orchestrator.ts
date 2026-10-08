/**
 * The Instagram run loop: take the plan's next step, do it, ask again.
 *
 * The plan is recomputed after every action rather than executed as a batch,
 * because each action changes the state it was computed from — a follow-back
 * noticed, a lead filtered out, a cap spent, a block. The planner is pure and
 * seeded (planner/planner.ts); this file is the part that is allowed to have
 * consequences.
 *
 * Three jobs live here, and they are deliberately separate so the dangerous
 * one is never a side effect of the safe one:
 *
 * - `harvestIg` collects leads. Follows nothing, sends nothing.
 * - `checkIg` reads our followers and our inbox. Changes lead state but
 *   contacts nobody.
 * - `runIg` follows and messages. The only one that reaches out.
 *
 * Every one of them stops dead on a block: the breaker is sticky, and it is
 * shared by all three.
 */
import type {
  IgHarvestContext, IgRunner, IgStore,
} from './domain/contracts.ts';
import type { Id, IgCampaign, IgLead } from './domain/types.ts';
import { toIso } from '../core/time.ts';
import { plan, type PlannedStep } from './planner/planner.ts';
import {
  markBlocked, markFailed, markFollowed, markFollowedBack, markMessaged, markOptedOut,
  markReplied, markSkipped,
} from './planner/lifecycle.ts';
import { renderMessage } from './planner/messages.ts';

export interface IgRunDeps {
  store: IgStore;
  runner: IgRunner;
  log?: (msg: string) => void;
  /** True once the human has asked the job to stop. */
  cancelled?: () => boolean;
  /** Injected for tests. Defaults to the clock. */
  now?: () => Date;
  /** Injected for tests. Defaults to a real wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface IgRunSummary {
  follows: number;
  dms: number;
  skipped: number;
  failed: number;
  /** Why the run ended. */
  stopReason: string;
  /** Things the human should see — a campaign with no message, a block. */
  warnings: string[];
  blocked: boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait, but notice a stop request while waiting. Long gaps are the norm. */
async function waitUntil(deps: IgRunDeps, targetMs: number): Promise<boolean> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => new Date());
  while (now().getTime() < targetMs) {
    if (deps.cancelled?.()) return false;
    const remaining = targetMs - now().getTime();
    await sleep(Math.min(remaining, 15_000));
    // A test's sleep may not advance its clock; a zero-length wait would spin.
    if (!deps.sleep) continue;
    if (now().getTime() < targetMs && remaining <= 15_000) break;
  }
  return !deps.cancelled?.();
}

/**
 * Follow and message, within today's caps and active hours.
 *
 * `maxSteps` is a safety rail for tests and for a human who wants a short
 * run; the caps are the real limit.
 */
export async function runIg(deps: IgRunDeps, opts: { maxSteps?: number } = {}): Promise<IgRunSummary> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const { store, runner } = deps;
  const summary: IgRunSummary = {
    follows: 0, dms: 0, skipped: 0, failed: 0, stopReason: 'nothing to do', warnings: [], blocked: false,
  };

  const settings = store.settings.get();
  if (settings.breakerTripped) {
    summary.stopReason = `breaker tripped: ${settings.breakerReason ?? 'no reason recorded'}`;
    log(`  STOPPED — ${summary.stopReason}`);
    return summary;
  }

  if (!(await runner.start())) {
    summary.stopReason = 'not signed in to Instagram';
    return summary;
  }

  const seen = new Set<string>();
  for (let step = 0; step < (opts.maxSteps ?? Number.MAX_SAFE_INTEGER); step++) {
    if (deps.cancelled?.()) {
      summary.stopReason = 'stopped by the human';
      break;
    }

    const current = planNow(store, now());
    for (const warning of current.warnings) {
      if (!summary.warnings.includes(warning)) {
        summary.warnings.push(warning);
        log(`  NOTE: ${warning}`);
      }
    }

    const next = current.steps[0];
    if (!next) {
      summary.stopReason = current.stopReason;
      break;
    }

    // The planner schedules the gap between actions; honour it rather than
    // racing ahead. This is the main reason a run takes hours, and it is the
    // point: twenty follows in two minutes is the pattern that gets noticed.
    const dueMs = Date.parse(next.at);
    if (dueMs > now().getTime()) {
      const minutes = Math.round((dueMs - now().getTime()) / 60_000);
      if (minutes >= 1) log(`  waiting ${minutes} min until the next action`);
      if (!(await waitUntil(deps, dueMs))) {
        summary.stopReason = 'stopped by the human';
        break;
      }
    }

    // A step the planner keeps re-offering after it has been attempted means
    // the loop would spin: stop rather than hammer one lead.
    const key = `${next.kind}:${next.leadId}`;
    if (seen.has(key)) {
      summary.stopReason = `the plan did not advance past ${next.kind} for @${next.username}`;
      log(`  STOPPED — ${summary.stopReason}`);
      break;
    }
    seen.add(key);

    const outcome = next.kind === 'follow'
      ? await doFollow(deps, next, summary)
      : await doDm(deps, next, summary);

    if (outcome === 'blocked') {
      summary.blocked = true;
      summary.stopReason = 'Instagram pushed back — the breaker is tripped';
      break;
    }
    if (outcome === 'stop') {
      summary.stopReason = 'stopped by the human';
      break;
    }
  }

  log('');
  log(`  ${summary.follows} follow(s), ${summary.dms} DM(s), ${summary.skipped} skipped, ${summary.failed} failed`);
  log(`  ended: ${summary.stopReason}`);
  return summary;
}

type StepOutcome = 'done' | 'blocked' | 'stop';

/**
 * The plan as it stands right now.
 *
 * Exported because the UI's dry run must show exactly what a run would do —
 * same function, same inputs, and the planner is seeded, so the plan you
 * inspect is the plan that runs.
 */
export function planNow(store: IgStore, now: Date) {
  const campaigns = store.campaigns.list({ activeOnly: true });
  const day = dayWindow(now);
  return plan({
    now: toIso(now.getTime()),
    settings: store.settings.get(),
    campaigns,
    leads: [...store.leads.list({ status: 'new' }), ...store.leads.list({ status: 'followed' })],
    variants: store.variants.list({ activeOnly: true }),
    doneToday: {
      follow: store.actions.countBetween('follow', day.from, day.to),
      dm: store.actions.countBetween('dm', day.from, day.to),
      profileVisit: store.actions.countBetween('profile_visit', day.from, day.to),
    },
    lastDmVariantId: store.actions.lastDmVariantId(),
  });
}

/**
 * The window the daily caps are counted over.
 *
 * The planner works in the configured timezone, but the counts come from the
 * action log, which is UTC. A local-day window is computed by the store's own
 * settings there; here it is the calendar day around `now`, which is the same
 * thing for every timezone this tool is used in and errs towards counting a
 * few extra actions rather than missing some.
 */
function dayWindow(now: Date): { from: string; to: string } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

async function doFollow(
  deps: IgRunDeps,
  step: Extract<PlannedStep, { kind: 'follow' }>,
  summary: IgRunSummary,
): Promise<StepOutcome> {
  const log = deps.log ?? (() => {});
  const { store, runner } = deps;
  const at = toIso((deps.now ?? (() => new Date()))().getTime());

  const campaign = store.campaigns.get(step.campaignId);
  if (!campaign) {
    markFailed(store, step.leadId, 'follow', 'campaign disappeared mid-run', at);
    summary.failed++;
    return 'done';
  }

  log(`  follow @${step.username} (${campaign.name})`);
  const result = await runner.follow(step.username, campaign.filters);

  switch (result.outcome) {
    case 'followed':
      markFollowed(store, step.leadId, at, { followsUs: result.followsUs });
      summary.follows++;
      return 'done';
    case 'already-following':
      markFollowed(store, step.leadId, at, { followsUs: result.followsUs, alreadyFollowing: true });
      summary.follows++;
      return 'done';
    case 'skipped':
      markSkipped(store, step.leadId, result.reason, at);
      summary.skipped++;
      // The human asking to stop arrives as a skip from the browser layer.
      return /stopped by the human/i.test(result.reason) ? 'stop' : 'done';
    case 'failed':
      if (/stopped by the human/i.test(result.error)) return 'stop';
      markFailed(store, step.leadId, 'follow', result.error, at);
      summary.failed++;
      log(`    failed: ${result.error}`);
      return 'done';
    case 'blocked':
      markBlocked(store, step.leadId, 'follow', result.reason, at);
      log(`  BLOCKED: ${result.reason}`);
      return 'blocked';
  }
}

async function doDm(
  deps: IgRunDeps,
  step: Extract<PlannedStep, { kind: 'dm' }>,
  summary: IgRunSummary,
): Promise<StepOutcome> {
  const log = deps.log ?? (() => {});
  const { store, runner } = deps;
  const at = toIso((deps.now ?? (() => new Date()))().getTime());

  const lead = store.leads.get(step.leadId);
  const variant = store.variants.get(step.variantId);
  if (!lead || !variant) {
    markFailed(store, step.leadId, 'dm', 'lead or message variant disappeared mid-run', at);
    summary.failed++;
    return 'done';
  }

  const text = renderMessage(variant.text, lead);
  if (variant.imagePath) {
    // Variant images are stored, protected from the media cleanup, and shown
    // in the UI, but the DM composer does not attach them yet. Saying so is
    // better than quietly sending a message the human thinks had a picture
    // with it.
    const note = `variant ${variant.id} has an image, which is not sent yet — the text went out alone`;
    if (!summary.warnings.includes(note)) {
      summary.warnings.push(note);
      log(`  NOTE: ${note}`);
    }
  }

  log(`  DM @${step.username}`);
  const result = await runner.dm(step.username, text);

  switch (result.outcome) {
    case 'sent':
      markMessaged(store, step.leadId, variant.id, at);
      summary.dms++;
      return 'done';
    case 'skipped':
      summary.skipped++;
      log(`    skipped: ${result.reason}`);
      return /stopped by the human/i.test(result.reason) ? 'stop' : 'done';
    case 'failed':
      markFailed(store, step.leadId, 'dm', result.error, at);
      summary.failed++;
      log(`    failed: ${result.error}`);
      return 'done';
    case 'blocked':
      markBlocked(store, step.leadId, 'dm', result.reason, at);
      log(`  BLOCKED: ${result.reason}`);
      return 'blocked';
  }
}

// ---------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------

export interface IgHarvestSummary {
  added: number;
  duplicates: number;
  /** Pre-filtered-out counts by reason, summed across sources. */
  skipped: Record<string, number>;
  notes: string[];
  blocked: boolean;
}

/**
 * Collect leads for every active campaign (or just one).
 *
 * Nothing is followed or sent. Safe to run first, and the right way to find
 * out whether the selectors still work.
 */
export async function harvestIg(
  deps: IgRunDeps,
  opts: { campaignId?: Id } = {},
): Promise<IgHarvestSummary> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const { store, runner } = deps;
  const summary: IgHarvestSummary = { added: 0, duplicates: 0, skipped: {}, notes: [], blocked: false };

  const settings = store.settings.get();
  if (settings.breakerTripped) {
    summary.notes.push(`breaker tripped: ${settings.breakerReason ?? 'no reason recorded'}`);
    log(`  STOPPED — ${summary.notes[0]}`);
    return summary;
  }

  const campaigns = (opts.campaignId
    ? [store.campaigns.get(opts.campaignId)].filter((c): c is IgCampaign => c !== null)
    : store.campaigns.list({ activeOnly: true }));
  if (campaigns.length === 0) {
    summary.notes.push('no active campaign to harvest');
    return summary;
  }

  if (!(await runner.start())) {
    summary.notes.push('not signed in to Instagram');
    return summary;
  }

  const ctx: IgHarvestContext = { isKnown: (u) => store.leads.hasUsername(u) };

  for (const campaign of campaigns) {
    log('');
    log(`  campaign "${campaign.name}" — ${campaign.sources.length} source(s)`);
    for (const source of campaign.sources) {
      if (deps.cancelled?.()) {
        summary.notes.push('stopped by the human');
        return summary;
      }

      const at = toIso(now().getTime());
      const result = await runner.harvest(campaign, source, ctx);

      for (const [reason, count] of Object.entries(result.skipped)) {
        summary.skipped[reason] = (summary.skipped[reason] ?? 0) + count;
      }
      summary.notes.push(...result.notes.map((n) => `${source}: ${n}`));

      if (result.blocked) {
        markBlocked(store, null, 'harvest', result.blocked, at);
        summary.blocked = true;
        log(`  BLOCKED: ${result.blocked}`);
        return summary;
      }

      const { added, duplicates } = store.leads.addHarvested(campaign.id, result.people, at);
      summary.added += added.length;
      summary.duplicates += duplicates;
      store.actions.record({
        kind: 'harvest',
        outcome: 'ok',
        leadId: null,
        campaignId: campaign.id,
        at,
        detail: `${source}: ${result.postsRead} post(s), ${added.length} new, ${duplicates} already known`,
      });
      log(`  ${source}: ${added.length} new lead(s), ${duplicates} already known`);
    }
  }

  log('');
  log(`  ${summary.added} new lead(s), ${summary.duplicates} already known`);
  return summary;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface IgCheckSummary {
  followBacks: number;
  replies: number;
  optOuts: number;
  notes: string[];
  blocked: boolean;
}

/**
 * Notice follow-backs and replies.
 *
 * A follow-back pulls that lead's DM forward (they have seen us and acted). A
 * reply stops the sequence for that lead so a human answers. "Not interested"
 * marks the lead opted_out, which is permanent and global.
 *
 * Run this before `runIg` — a lead that replied must not then be messaged.
 */
export async function checkIg(deps: IgRunDeps): Promise<IgCheckSummary> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const { store, runner } = deps;
  const summary: IgCheckSummary = { followBacks: 0, replies: 0, optOuts: 0, notes: [], blocked: false };

  const settings = store.settings.get();
  if (settings.breakerTripped) {
    summary.notes.push(`breaker tripped: ${settings.breakerReason ?? 'no reason recorded'}`);
    return summary;
  }
  if (!(await runner.start())) {
    summary.notes.push('not signed in to Instagram');
    return summary;
  }

  const at = toIso(now().getTime());

  // --- follow-backs ---
  const waiting = store.leads.list({ status: 'followed' }).filter((l) => l.followedBackAt === null);
  if (waiting.length > 0) {
    const followers = await runner.followers();
    if (followers.outcome === 'blocked') {
      markBlocked(store, null, 'check', followers.reason, at);
      summary.blocked = true;
      log(`  BLOCKED: ${followers.reason}`);
      return summary;
    }
    if (followers.outcome === 'failed') {
      summary.notes.push(`followers list: ${followers.error}`);
    } else {
      for (const lead of waiting) {
        if (!followers.followers.has(lead.username)) continue;
        markFollowedBack(store, lead.id, at);
        summary.followBacks++;
        log(`  @${lead.username} followed back`);
      }
      store.actions.record({
        kind: 'check', outcome: 'ok', leadId: null, campaignId: null, at,
        detail: `follow-back check: ${summary.followBacks} of ${waiting.length} waiting`,
      });
    }
  }

  // --- replies ---
  const messaged: IgLead[] = store.leads.list({ status: 'messaged' });
  if (messaged.length > 0) {
    const inbox = await runner.inbox(messaged.map((l) => ({
      id: l.id, username: l.username, displayName: l.displayName,
    })));
    if (inbox.outcome === 'blocked') {
      markBlocked(store, null, 'check', inbox.reason, at);
      summary.blocked = true;
      log(`  BLOCKED: ${inbox.reason}`);
      return summary;
    }
    if (inbox.outcome === 'failed') {
      summary.notes.push(`inbox: ${inbox.error}`);
    } else {
      for (const entry of inbox.entries) {
        if (entry.leadId === null) {
          // Unmatched threads are left to the human on purpose: guessing which
          // lead a display name belongs to risks stopping the wrong sequence.
          if (entry.unread) summary.notes.push(`unread thread "${entry.title}" could not be matched to a lead`);
          continue;
        }
        if (entry.kind === 'opt-out') {
          markOptedOut(store, entry.leadId, `said: ${entry.preview.slice(0, 120)}`);
          summary.optOuts++;
          log(`  @${entry.title} opted out`);
        } else {
          markReplied(store, entry.leadId, at);
          summary.replies++;
          log(`  @${entry.title} replied`);
        }
      }
      store.actions.record({
        kind: 'check', outcome: 'ok', leadId: null, campaignId: null, at,
        detail: `inbox check: ${summary.replies} reply(ies), ${summary.optOuts} opt-out(s)`,
      });
    }
  }

  log('');
  log(`  ${summary.followBacks} follow-back(s), ${summary.replies} reply(ies), ${summary.optOuts} opt-out(s)`);
  return summary;
}
