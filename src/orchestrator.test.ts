/**
 * Run-loop behaviour, with a fake runner and fake time.
 *
 * The case that matters here is the one that shipped broken: a round schedules
 * its posts minutes apart, and the loop used to end the moment nothing was
 * due — posting exactly one item and closing the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store/sqlite-store.ts';
import { createOrchestrator } from './orchestrator.ts';
import type { PostJob, PostResult, Runner, Store } from './domain/contracts.ts';
import type { Id } from './domain/types.ts';

const MIN = 60_000;

function fixture() {
  const store = openStore(':memory:');
  store.settings.update({
    timezone: 'UTC', roundMinGapMinutes: 5, roundMaxGapMinutes: 12,
    minGapMinutes: 18, maxGapMinutes: 55, defaultRunnerMode: 'auto',
  });
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const ad = store.ads.create({ businessId: biz.id, name: 'Promo', composerType: 'status', active: true });
  const variant = store.ads.createVariant({
    adId: ad.id, caption: 'hello', listingTitle: null, listingPriceCents: null,
    listingCategory: null, listingLocation: null, imagePaths: [], weight: 1, active: true,
  });
  const groupIds: Id[] = [];
  for (let i = 0; i < 4; i++) {
    groupIds.push(store.groups.create({
      fbGroupId: `g${i}`, name: `Group ${i}`, url: `https://facebook.com/groups/g${i}`,
      memberCount: 10, composerType: 'status', active: true, cooldownDaysOverride: null,
      rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
    }).id);
  }
  return { store, bizId: biz.id, adId: ad.id, variantId: variant.id, groupIds };
}

/**
 * A clock the test drives. `sleep` advances it instead of waiting, so a run
 * that spans hours of scheduled time finishes instantly and deterministically.
 */
function fakeClock(startMs: number) {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    sleep: async (waitMs: number) => { ms += waitMs; },
    get ms() { return ms; },
  };
}

function recordingRunner(result: PostResult = { outcome: 'posted' }): Runner & { jobs: PostJob[] } {
  const jobs: PostJob[] = [];
  return {
    jobs,
    async start() {},
    async post(job) { jobs.push(job); return result; },
    async stop() {},
  };
}

function queueRound(store: Store, o: {
  bizId: Id; adId: Id; variantId: Id; groupIds: Id[]; startMs: number; gapMs: number; roundId: string | null;
}) {
  return store.queue.createMany(o.groupIds.map((groupId, i) => ({
    businessId: o.bizId, groupId, adId: o.adId, variantId: o.variantId,
    scheduledFor: new Date(o.startMs + i * o.gapMs).toISOString(),
    status: 'pending' as const, runnerMode: 'auto' as const, roundId: o.roundId,
  })));
}

const START = Date.parse('2026-09-10T10:00:00.000Z');

// --- the regression ---------------------------------------------------------

test('a run works through a whole round, not just the first post', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  queueRound(store, { bizId, adId, variantId, groupIds, startMs: START, gapMs: 7 * MIN, roundId: 'r1' });

  const clock = fakeClock(START);
  const runner = recordingRunner();
  const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

  // One gap plus slack, exactly what the round job passes.
  return orch.runDue(groupIds.length, 17 * MIN).then((summary) => {
    assert.equal(summary.posted, 4, 'every group in the round must be posted to');
    assert.equal(summary.attempted, 4);
    assert.deepEqual(runner.jobs.map((j) => j.group.id), groupIds);
    assert.equal(store.queue.list({ status: 'pending' }).length, 0);
    store.close();
  });
});

test('without a horizon the run still stops at the first not-yet-due item', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  queueRound(store, { bizId, adId, variantId, groupIds, startMs: START, gapMs: 7 * MIN, roundId: 'r1' });

  const clock = fakeClock(START);
  const runner = recordingRunner();
  const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

  // The drip run keeps the old behaviour on purpose: a run started at midnight
  // must not hold a browser open until the morning.
  return orch.runDue(10).then((summary) => {
    assert.equal(summary.posted, 1);
    assert.equal(summary.stoppedBecause, 'nothing-due');
    store.close();
  });
});

test('the run refuses to wait past the horizon', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  // Second post is 4 hours out — far beyond a round gap.
  queueRound(store, {
    bizId, adId, variantId, groupIds: groupIds.slice(0, 2),
    startMs: START, gapMs: 240 * MIN, roundId: 'r1',
  });

  const clock = fakeClock(START);
  const runner = recordingRunner();
  const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

  return orch.runDue(10, 17 * MIN).then((summary) => {
    assert.equal(summary.posted, 1);
    assert.equal(summary.stoppedBecause, 'nothing-due');
    store.close();
  });
});

test('waiting for the schedule does not also apply the inter-post gap', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  queueRound(store, {
    bizId, adId, variantId, groupIds: groupIds.slice(0, 3),
    startMs: START, gapMs: 6 * MIN, roundId: 'r1',
  });

  const clock = fakeClock(START);
  const orch = createOrchestrator({
    store, runner: recordingRunner(), now: clock.now, sleep: clock.sleep, log: () => {},
  });

  return orch.runDue(3, 17 * MIN).then(() => {
    // Three posts at 0, +6, +12 min. If the scheduled wait and the random
    // inter-post pause both fired, the clock would have run far past 12 min.
    const elapsedMin = (clock.ms - START) / MIN;
    assert.ok(elapsedMin <= 13, `elapsed ${elapsedMin} min — the gap was applied twice`);
    store.close();
  });
});

test('a backlog of already-due posts is still paced, not fired back to back', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  // Everything scheduled in the past: all due at once.
  queueRound(store, {
    bizId, adId, variantId, groupIds: groupIds.slice(0, 3),
    startMs: START - 60 * MIN, gapMs: 0, roundId: 'r1',
  });

  const clock = fakeClock(START);
  const orch = createOrchestrator({
    store, runner: recordingRunner(), now: clock.now, sleep: clock.sleep, log: () => {},
  });

  return orch.runDue(3, 17 * MIN).then((summary) => {
    assert.equal(summary.posted, 3);
    // Two gaps at the round rate (5-12 min) must have elapsed.
    const elapsedMin = (clock.ms - START) / MIN;
    assert.ok(elapsedMin >= 10, `elapsed ${elapsedMin} min — a drained backlog was posted as a burst`);
    store.close();
  });
});

test('a block trips the breaker and abandons the rest of the round', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  queueRound(store, { bizId, adId, variantId, groupIds, startMs: START, gapMs: 7 * MIN, roundId: 'r1' });

  const clock = fakeClock(START);
  const runner = recordingRunner({ outcome: 'blocked', error: 'checkpoint' });
  const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

  return orch.runDue(4, 17 * MIN).then((summary) => {
    assert.equal(summary.blocked, 1);
    assert.equal(summary.attempted, 1, 'the round must stop dead on the first block');
    assert.equal(store.settings.get().breakerTripped, true);
    store.close();
  });
});

test('stop() ends the run even while it is waiting for the next post', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  queueRound(store, { bizId, adId, variantId, groupIds, startMs: START, gapMs: 7 * MIN, roundId: 'r1' });

  const clock = fakeClock(START);
  const runner = recordingRunner();
  const orch = createOrchestrator({
    store,
    runner,
    now: clock.now,
    // Ask to stop partway through the first wait. The wait is served in slices
    // precisely so this is noticed instead of running to completion.
    sleep: async (ms) => { await clock.sleep(ms); orch.stop(); },
    log: () => {},
  });

  return orch.runDue(4, 17 * MIN).then((summary) => {
    assert.equal(summary.stoppedBecause, 'stopped');
    assert.ok(summary.posted < 4, 'stop must cut the round short');
    store.close();
  });
});

// --- group-level vs account-wide pushback ------------------------------------

/** A runner that plays back one scripted result per post, then posts normally. */
function scriptedRunner(results: PostResult[]): Runner & { jobs: PostJob[] } {
  const jobs: PostJob[] = [];
  return {
    jobs,
    async start() {},
    async post(job) { jobs.push(job); return results[jobs.length - 1] ?? { outcome: 'posted' }; },
    async stop() {},
  };
}

test('a group-level restriction does not trip the breaker, is not requeued, and the run moves on', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  const items = queueRound(store, { bizId, adId, variantId, groupIds, startMs: START, gapMs: 7 * MIN, roundId: 'r1' });

  const clock = fakeClock(START);
  const runner = scriptedRunner([
    { outcome: 'blocked', blockKind: 'group-restricted', error: 'page said "only admins can post" (group-restricted)' },
  ]);
  const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

  return orch.runDue(4, 17 * MIN).then((summary) => {
    assert.equal(store.settings.get().breakerTripped, false, 'one group refusing must not stop the account');
    assert.equal(summary.blocked, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.posted, 3, 'the rest of the round must still go out');
    assert.equal(store.queue.get(items[0]!.id)?.status, 'failed', 'must not go back to pending — that is a repost');
    const history = store.log.list({ groupId: groupIds[0] });
    assert.equal(history.length, 1);
    assert.equal(history[0]!.outcome, 'failed');
    assert.match(history[0]!.error ?? '', /group-level/);
    store.close();
  });
});

test('a post pending admin approval is recorded as posted, so the cooldown applies', () => {
  const { store, bizId, adId, variantId, groupIds } = fixture();
  const items = queueRound(store, {
    bizId, adId, variantId, groupIds: groupIds.slice(0, 1), startMs: START, gapMs: 0, roundId: null,
  });

  const clock = fakeClock(START);
  // Deliberately the raw form a runner might report; the orchestrator must
  // still refuse to treat it as a block.
  const runner = scriptedRunner([
    { outcome: 'blocked', blockKind: 'pending-approval', fbPostUrl: 'https://facebook.com/groups/g0', error: 'pending' },
  ]);
  const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

  return orch.runDue(1).then((summary) => {
    assert.equal(summary.posted, 1);
    assert.equal(summary.blocked, 0);
    assert.equal(store.settings.get().breakerTripped, false);
    assert.equal(store.queue.get(items[0]!.id)?.status, 'posted');
    const last = store.log.lastPostToGroup(groupIds[0]!);
    assert.ok(last, 'cooldown maths must see this post');
    assert.equal(last.detail, 'pending admin approval');
    store.close();
  });
});

for (const kind of ['rate-limit', 'checkpoint', 'captcha', 'temporary-block', 'login-required'] as const) {
  test(`an account-wide ${kind} requeues the item and trips the breaker`, () => {
    const { store, bizId, adId, variantId, groupIds } = fixture();
    const items = queueRound(store, { bizId, adId, variantId, groupIds, startMs: START, gapMs: 7 * MIN, roundId: 'r1' });

    const clock = fakeClock(START);
    const runner = scriptedRunner([{ outcome: 'blocked', blockKind: kind, error: kind }]);
    const orch = createOrchestrator({ store, runner, now: clock.now, sleep: clock.sleep, log: () => {} });

    return orch.runDue(4, 17 * MIN).then((summary) => {
      assert.equal(summary.blocked, 1);
      assert.equal(summary.attempted, 1, 'the run must stop on the first account-wide block');
      assert.equal(summary.stoppedBecause, 'breaker');
      assert.equal(store.settings.get().breakerTripped, true);
      assert.equal(store.queue.get(items[0]!.id)?.status, 'pending');
      store.close();
    });
  });
}
