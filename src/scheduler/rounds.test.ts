import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../store/sqlite-store.ts';
import { commitRound, planRound } from './rounds.ts';
import type { Store } from '../domain/contracts.ts';
import type { Id } from '../domain/types.ts';

const HOUR = 3_600_000;
/** Mid-morning UTC, comfortably inside the default 08:00-21:00 window. */
const NOW = Date.parse('2026-09-09T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function setup(opts: { groups?: number; variants?: number } = {}) {
  const store = openStore(':memory:');
  store.settings.update({ timezone: 'UTC' });

  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const ad = store.ads.create({ businessId: biz.id, name: 'Promo', composerType: 'status', active: true });
  for (let v = 0; v < (opts.variants ?? 3); v++) {
    store.ads.createVariant({
      adId: ad.id, caption: `variant ${v}`, listingTitle: null, listingPriceCents: null,
      listingCategory: null, listingLocation: null, imagePaths: [], weight: 1, active: true,
    });
  }

  const groupIds: Id[] = [];
  for (let i = 0; i < (opts.groups ?? 6); i++) {
    const g = store.groups.create({
      fbGroupId: `g${i}`, name: `Group ${i}`, url: `https://facebook.com/groups/g${i}`,
      memberCount: 100, composerType: 'status', active: true, cooldownDaysOverride: null,
      rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
    });
    groupIds.push(g.id);
  }
  store.groups.setAssignments(biz.id, groupIds);

  return { store, bizId: biz.id, adId: ad.id, groupIds };
}

function logRoundPost(
  store: Store,
  o: { groupId: Id; businessId: Id; adId: Id; whenMs: number; roundId: string | null },
) {
  store.log.append({
    queueItemId: null, groupId: o.groupId, businessId: o.businessId, adId: o.adId,
    variantId: store.ads.variants(o.adId)[0]!.id,
    outcome: 'posted', postedAt: iso(o.whenMs),
    fbPostUrl: null, error: null, detail: null, roundId: o.roundId,
  });
}

const round = (store: Store, businessId: Id, seed = 7) =>
  planRound(store, { businessId, now: iso(NOW), seed });

// --- the core promise --------------------------------------------------------

test('a round reaches every selected group, ignoring the day-scale cooldowns', () => {
  const { store, bizId, groupIds, adId } = setup({ groups: 6 });
  // A post yesterday would put every group inside the 7-day per-group cooldown
  // AND the 21-day per-ad cooldown. The drip planner would exclude all of them;
  // a round must not, because overriding exactly that is what it is for.
  for (const groupId of groupIds) {
    logRoundPost(store, { groupId, businessId: bizId, adId, whenMs: NOW - 26 * HOUR, roundId: 'round-old' });
  }

  const plan = round(store, bizId);
  assert.equal(plan.posts.length, 6);
  assert.deepEqual([...plan.posts.map((p) => p.groupId)].sort((a, b) => a - b), [...groupIds].sort((a, b) => a - b));
});

test('a second round the same day is refused until the rest period has passed', () => {
  const { store, bizId, groupIds, adId } = setup({ groups: 3 });
  store.settings.update({ minHoursBetweenRounds: 3, roundsPerDay: 3 });

  // One hour ago: inside the 3h rest, so nothing is eligible.
  for (const groupId of groupIds) {
    logRoundPost(store, { groupId, businessId: bizId, adId, whenMs: NOW - 1 * HOUR, roundId: 'r1' });
  }
  const tooSoon = round(store, bizId);
  assert.equal(tooSoon.posts.length, 0);
  assert.ok(tooSoon.exclusions.every((e) => e.reason === 'round-too-soon'));

  // Four hours ago: past the rest, so the same groups come back.
  const fresh = setup({ groups: 3 });
  fresh.store.settings.update({ timezone: 'UTC', minHoursBetweenRounds: 3, roundsPerDay: 3 });
  for (const groupId of fresh.groupIds) {
    logRoundPost(fresh.store, {
      groupId, businessId: fresh.bizId, adId: fresh.adId, whenMs: NOW - 4 * HOUR, roundId: 'r1',
    });
  }
  assert.equal(round(fresh.store, fresh.bizId).posts.length, 3);
});

test('roundsPerDay is a hard ceiling per group, independent of the rest period', () => {
  const { store, bizId, groupIds, adId } = setup({ groups: 2 });
  store.settings.update({ roundsPerDay: 2, minHoursBetweenRounds: 1 });

  const [busy, quiet] = groupIds as [Id, Id];
  // Two rounds already, both long enough ago to clear the 1h rest.
  logRoundPost(store, { groupId: busy, businessId: bizId, adId, whenMs: NOW - 6 * HOUR, roundId: 'r1' });
  logRoundPost(store, { groupId: busy, businessId: bizId, adId, whenMs: NOW - 3 * HOUR, roundId: 'r2' });

  const plan = round(store, bizId);
  assert.deepEqual(plan.posts.map((p) => p.groupId), [quiet]);
  assert.equal(plan.exclusions.find((e) => e.groupId === busy)?.reason, 'rounds-today');
});

test('drip posts do not count towards the round guards', () => {
  const { store, bizId, groupIds, adId } = setup({ groups: 2 });
  store.settings.update({ roundsPerDay: 1, minHoursBetweenRounds: 12 });
  // roundId null = a normal planned post. It must not consume a group's round
  // allowance, or one drip post would lock the group out of rounds all day.
  for (const groupId of groupIds) {
    logRoundPost(store, { groupId, businessId: bizId, adId, whenMs: NOW - 1 * HOUR, roundId: null });
  }
  assert.equal(round(store, bizId).posts.length, 2);
});

test('roundDailyCap limits the round and names the reason', () => {
  const { store, bizId } = setup({ groups: 6 });
  store.settings.update({ roundDailyCap: 4 });

  const plan = round(store, bizId);
  assert.equal(plan.posts.length, 4);
  assert.equal(plan.exclusions.filter((e) => e.reason === 'round-daily-cap').length, 2);
});

test('inactive and quarantined groups stay excluded inside a round', () => {
  const { store, bizId, groupIds } = setup({ groups: 3 });
  const [off, quarantined, ok] = groupIds as [Id, Id, Id];
  store.groups.update(off, { active: false });
  store.groups.update(quarantined, {
    quarantinedUntil: iso(NOW + 48 * HOUR), quarantineReason: 'admin warned us',
  });

  const plan = round(store, bizId);
  assert.deepEqual(plan.posts.map((p) => p.groupId), [ok]);
  assert.equal(plan.exclusions.find((e) => e.groupId === off)?.reason, 'group-inactive');
  assert.equal(plan.exclusions.find((e) => e.groupId === quarantined)?.reason, 'group-quarantined');
});

// --- pacing and rotation -----------------------------------------------------

test('posts are spaced by the round gap, not the drip gap', () => {
  const { store, bizId } = setup({ groups: 5 });
  store.settings.update({
    roundMinGapMinutes: 5, roundMaxGapMinutes: 12,
    minGapMinutes: 18, maxGapMinutes: 55, // must NOT be used
  });

  const times = round(store, bizId).posts.map((p) => Date.parse(p.scheduledFor));
  assert.equal(times.length, 5);
  for (let i = 1; i < times.length; i++) {
    const gapMin = (times[i]! - times[i - 1]!) / 60_000;
    assert.ok(gapMin >= 5 && gapMin <= 12, `gap ${gapMin} outside 5-12 min`);
  }
});

test('the same caption never lands in two consecutive groups', () => {
  const { store, bizId } = setup({ groups: 12, variants: 3 });
  const ids = round(store, bizId).posts.map((p) => p.variantId);
  for (let i = 1; i < ids.length; i++) {
    assert.notEqual(ids[i], ids[i - 1], `variant repeated back-to-back at index ${i}`);
  }
});

test('a round is deterministic for a given seed', () => {
  const { store, bizId } = setup({ groups: 8 });
  const a = planRound(store, { businessId: bizId, now: iso(NOW), seed: 99 });
  const b = planRound(store, { businessId: bizId, now: iso(NOW), seed: 99 });
  assert.deepEqual(a.posts, b.posts);
});

test('outside active hours a round still plans, but warns', () => {
  const { store, bizId } = setup({ groups: 2 });
  const night = Date.parse('2026-09-09T02:00:00.000Z');
  const plan = planRound(store, { businessId: bizId, now: iso(night), seed: 1 });
  assert.equal(plan.posts.length, 2);
  assert.match(plan.warning ?? '', /outside your active hours/);
  assert.equal(round(store, bizId).warning, null); // 10:00 is fine
});

// --- commit ------------------------------------------------------------------

test('commit stamps the round id and the CURRENT runner mode', () => {
  const { store, bizId } = setup({ groups: 3 });
  store.settings.update({ defaultRunnerMode: 'auto' });

  const plan = round(store, bizId);
  const items = commitRound(store, plan);

  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.roundId === plan.roundId));
  assert.ok(items.every((i) => i.runnerMode === 'auto'));
});

test('switching to auto re-stamps items committed while assisted', () => {
  const { store, bizId } = setup({ groups: 3 });
  commitRound(store, round(store, bizId)); // committed as assisted

  assert.equal(store.queue.setModeForWaiting('auto'), 3);
  assert.ok(store.queue.list({ status: 'pending' }).every((i) => i.runnerMode === 'auto'));
});

test('clearRounds drops unposted round items and leaves drip items alone', () => {
  const { store, bizId, groupIds, adId } = setup({ groups: 3 });
  const [gid] = groupIds as [Id];
  store.queue.createMany([{
    businessId: bizId, groupId: gid, adId, variantId: store.ads.variants(adId)[0]!.id,
    scheduledFor: iso(NOW), status: 'pending', runnerMode: 'assisted', roundId: null,
  }]);
  commitRound(store, round(store, bizId));

  assert.equal(store.queue.clearRounds(), 3);
  const left = store.queue.list();
  assert.equal(left.length, 1);
  assert.equal(left[0]!.roundId, null);
});

test('an ad with no active variants is not sendable as a round', () => {
  const { store, bizId, adId } = setup({ groups: 2 });
  for (const v of store.ads.variants(adId)) store.ads.updateVariant(v.id, { active: false });
  assert.throws(() => round(store, bizId), /no active ad/);
});
