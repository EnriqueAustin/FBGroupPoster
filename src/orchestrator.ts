/**
 * The run loop. Owns the one rule that everything else depends on:
 * nothing gets posted while the circuit breaker is tripped, and any sign of
 * pushback from Facebook trips it.
 *
 * Deliberately thin. Scheduling decisions live in src/scheduler; browser work
 * lives in src/runner. This file only sequences them and records what happened.
 */
import type { PostResult, Runner, Store } from './domain/contracts.ts';
import type { Id, PostOutcome, QueueItem } from './domain/types.ts';
// Pure policy function with no browser dependency (detect.ts only imports
// Playwright's types). Imported rather than restated so "which blocks stop the
// run" has exactly one definition.
import { isAccountWide } from './runner/detect.ts';

export interface OrchestratorOptions {
  store: Store;
  runner: Runner;
  /** Injectable for tests. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface RunSummary {
  attempted: number;
  posted: number;
  skipped: number;
  failed: number;
  blocked: number;
  stoppedBecause: 'nothing-due' | 'breaker' | 'limit-reached' | 'stopped';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Turn what the runner saw into what the run should do about it.
 *
 * The runner reports every kind of pushback as 'blocked'. Only account-wide
 * ones may trip the breaker: one group refusing a post says nothing about the
 * account, and stopping the whole run for it (while also requeueing the item
 * for that same group) was both over-cautious and a source of duplicates.
 *
 * - account-wide, or no kind given   → stays 'blocked' (requeue + breaker).
 *   A missing kind is treated as the worst case on purpose.
 * - 'pending-approval'               → 'posted'. The post went out and waits
 *   for an admin; the cooldown must start. (The runner already maps this
 *   itself; handled here too so a runner that doesn't cannot cause a repost.)
 * - 'group-restricted'               → 'failed' for this item only. Not
 *   requeued: the group refused us, and retrying it later would just get the
 *   same answer. 'failed' rather than 'skipped' so it stands out in history
 *   as something a human should look at (leave the group, fix its settings).
 */
export function resolveResult(result: PostResult): PostResult {
  if (result.outcome !== 'blocked') return result;
  const kind = result.blockKind;
  if (!kind || isAccountWide(kind)) return result;

  if (kind === 'pending-approval') {
    return { outcome: 'posted', fbPostUrl: result.fbPostUrl, detail: 'pending admin approval' };
  }
  return {
    outcome: 'failed',
    blockKind: kind,
    error: `group-level restriction, not account-wide: ${result.error ?? kind}`,
    detail: result.detail,
  };
}

export function createOrchestrator(opts: OrchestratorOptions) {
  const { store, runner } = opts;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((m: string) => console.log(m));

  let stopRequested = false;

  /**
   * Sleep, but notice a Stop.
   *
   * A round now waits minutes at a time between posts. One long `await` would
   * ignore the Stop button for the whole of it, so the wait is served in slices
   * and abandoned as soon as someone asks it to end.
   */
  async function restUntilOrStop(totalMs: number): Promise<void> {
    const SLICE = 5_000;
    let left = totalMs;
    while (left > 0 && !stopRequested) {
      const chunk = Math.min(SLICE, left);
      await sleep(chunk);
      left -= chunk;
    }
  }

  /**
   * Trips the breaker and refuses further posting until a human clears it.
   * This is intentionally sticky: an automated reset would defeat the point,
   * because the whole purpose is to stop a bad pattern from continuing
   * unattended while the account is already under scrutiny.
   */
  function tripBreaker(reason: string): void {
    store.settings.update({
      breakerTripped: true,
      breakerReason: reason,
      breakerTrippedAt: now().toISOString(),
    });
    log(`\n!! CIRCUIT BREAKER TRIPPED: ${reason}`);
    log('   Nothing further will be posted until you clear it in Settings.');
    log('   Before clearing: open Facebook normally and check whether the');
    log('   account is under a posting restriction. Clearing this without');
    log('   checking is how a temporary block becomes a permanent one.\n');
  }

  /**
   * Assemble everything the runner needs. Returns null if the item is stale.
   *
   * The mode comes from settings, NOT from item.runnerMode. The item's copy is
   * a snapshot taken when the plan was committed, so turning auto on in
   * Settings used to leave every already-queued post assisted — the run still
   * stopped and asked, and the setting looked broken. Settings is the live
   * answer to "am I clicking Post, or is it?".
   */
  function hydrate(item: QueueItem) {
    const group = store.groups.get(item.groupId);
    const ad = store.ads.get(item.adId);
    const variant = store.ads.getVariant(item.variantId);
    if (!group || !ad || !variant) return null;
    const mode = store.settings.get().defaultRunnerMode;
    return { queueItemId: item.id, group, ad, variant, mode };
  }

  function record(item: QueueItem, outcome: PostOutcome, extra: { fbPostUrl?: string; error?: string; detail?: string }): void {
    store.log.append({
      queueItemId: item.id,
      groupId: item.groupId,
      businessId: item.businessId,
      adId: item.adId,
      variantId: item.variantId,
      outcome,
      postedAt: now().toISOString(),
      fbPostUrl: extra.fbPostUrl ?? null,
      error: extra.error ?? null,
      detail: extra.detail ?? null,
      // Carried through so the round guards (roundsPerDay, minHoursBetweenRounds)
      // can count what a group actually received rather than what was planned.
      roundId: item.roundId,
    });
  }

  /**
   * Work through everything currently due, one at a time, pausing between
   * posts. `maxPosts` is a belt-and-braces limit on top of the scheduler's
   * daily cap — the cap is enforced at plan time, this guards against a
   * mis-planned queue being drained in one go.
   *
   * `waitForUpcomingMs` is what makes a round work at all. A round schedules
   * its posts into the near future (now, +7 min, +5 min, …), but this loop only
   * ever picked up items that were ALREADY due — so it posted the first one,
   * found the second not yet due, and ended the run, closing the browser. From
   * the outside that looked exactly like "it posted once and stopped".
   *
   * With a horizon set, a run that has nothing due right now will wait for the
   * next scheduled item, provided it falls inside the horizon. Zero (the
   * default) keeps the original behaviour: a drip run started at midnight must
   * not sit holding a browser open until 08:00.
   */
  async function runDue(maxPosts: number, waitForUpcomingMs = 0): Promise<RunSummary> {
    const summary: RunSummary = { attempted: 0, posted: 0, skipped: 0, failed: 0, blocked: 0, stoppedBecause: 'nothing-due' };

    const settings = store.settings.get();
    if (settings.breakerTripped) {
      log(`Circuit breaker is tripped (${settings.breakerReason ?? 'no reason recorded'}). Refusing to post.`);
      summary.stoppedBecause = 'breaker';
      return summary;
    }

    await runner.start();
    try {
      while (!stopRequested && summary.attempted < maxPosts) {
        const item = store.queue.nextDue(now().toISOString());
        if (!item) {
          const nowIso = now().toISOString();
          const upcoming = store.queue.list({ status: ['pending', 'due'] })
            .filter((q) => q.scheduledFor > nowIso)
            .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];

          // Nothing due *yet* is not the same as nothing to do. Within the
          // horizon, hold the browser open and wait for it.
          if (upcoming && waitForUpcomingMs > 0) {
            const waitMs = Date.parse(upcoming.scheduledFor) - Date.parse(nowIso);
            if (waitMs <= waitForUpcomingMs) {
              log(`    waiting ${Math.max(1, Math.round(waitMs / 60_000))} min — next post at `
                + `${new Date(upcoming.scheduledFor).toLocaleTimeString()}`);
              await restUntilOrStop(waitMs);
              continue;
            }
          }

          // Say WHY nothing happened. Silence here reads as a broken run when
          // in fact everything is simply scheduled for later.
          if (summary.attempted === 0) {
            if (upcoming) {
              log(`Nothing is due yet. The next post is scheduled for ${new Date(upcoming.scheduledFor).toLocaleString()}.`);
              log('Use "Bring next post forward" on the Setup screen to run one now.');
            } else {
              log('Nothing is queued. Commit a plan first.');
            }
          } else if (upcoming) {
            log(`Stopping here — the next post (${new Date(upcoming.scheduledFor).toLocaleString()}) is `
              + 'further out than this run waits for.');
          }
          summary.stoppedBecause = 'nothing-due';
          break;
        }

        const job = hydrate(item);
        if (!job) {
          store.queue.update(item.id, { status: 'cancelled', lastError: 'referenced group/ad/variant no longer exists' });
          continue;
        }

        summary.attempted++;
        store.queue.update(item.id, { status: 'running', attempts: item.attempts + 1 });
        log(`[${summary.attempted}/${maxPosts}] ${job.group.name} — ${job.ad.name}`
          + `${job.mode === 'auto' ? '  [AUTO — it will click Post itself]' : '  [assisted — you click Post]'}`
          + `${item.roundId ? `  [${item.roundId}]` : ''}`);
        if (job.group.rulesNotes.trim()) log(`    group rules: ${job.group.rulesNotes.trim()}`);

        // Resolve BEFORE recording, so the history shows what actually
        // happened (e.g. 'posted' for a post awaiting approval) and cooldowns,
        // which read the history, see it too.
        const result = resolveResult(await runner.post(job));
        if (result.outcome === 'failed' && result.blockKind) {
          log(`    ${job.group.name} refused the post (${result.blockKind}) — moving on; the breaker is NOT tripped`);
        }
        record(item, result.outcome, result);

        switch (result.outcome) {
          case 'posted':
            summary.posted++;
            store.queue.update(item.id, { status: 'posted' });
            break;
          case 'skipped':
            summary.skipped++;
            store.queue.update(item.id, { status: 'skipped' });
            break;
          case 'failed':
            summary.failed++;
            store.queue.update(item.id, { status: 'failed', lastError: result.error ?? 'unknown error' });
            break;
          case 'blocked':
            // Only account-wide pushback reaches here — resolveResult has
            // already turned group-level refusals into 'failed'.
            summary.blocked++;
            // Put the item back so it is not lost, then stop everything.
            store.queue.update(item.id, { status: 'pending', lastError: result.error ?? 'blocked by Facebook' });
            tripBreaker(result.error ?? 'Facebook returned a block/checkpoint screen');
            summary.stoppedBecause = 'breaker';
            return summary;
        }

        // Pause between posts when the NEXT one is already due — a drained
        // backlog posted back-to-back is exactly the burst pattern the
        // scheduler exists to prevent. When the next item is still in the
        // future, its own scheduled time already provides the gap and the wait
        // at the top of the loop serves it; pausing here too would double it.
        const following = store.queue.nextDue(now().toISOString());
        if (following) {
          const s = store.settings.get();
          // A round is paced by its own, much shorter gaps — that is the whole
          // point of it. Mixing the two would either stretch a round across the
          // day or drip-post at round speed.
          const inRound = item.roundId !== null && following.roundId !== null;
          const min = (inRound ? s.roundMinGapMinutes : s.minGapMinutes) * 60_000;
          const max = (inRound ? s.roundMaxGapMinutes : s.maxGapMinutes) * 60_000;
          const waitMs = min + Math.random() * Math.max(0, max - min);
          log(`    waiting ${Math.round(waitMs / 60_000)} min before the next post`);
          await restUntilOrStop(waitMs);
        }
      }
      if (stopRequested) summary.stoppedBecause = 'stopped';
      else if (summary.attempted >= maxPosts) summary.stoppedBecause = 'limit-reached';
    } finally {
      await runner.stop();
    }
    return summary;
  }

  return {
    runDue,
    stop() { stopRequested = true; },
    tripBreaker,
    clearBreaker(): void {
      store.settings.update({ breakerTripped: false, breakerReason: null, breakerTrippedAt: null });
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
