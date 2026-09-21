import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../store/sqlite-store.ts';
import { createScheduler } from './planner.ts';
import { localHour } from './time.ts';
import type { Store } from '../domain/contracts.ts';
import type { Id } from '../domain/types.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-09T06:00:00.000Z'); // before the active window opens

/**
 * Timezone is pinned to UTC so assertions about active hours are readable.
 * Everything else uses the shipped defaults.
 */
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
  for (let i = 0; i < (opts.groups ?? 10); i++) {
    const g = store.groups.create({
      fbGroupId: `g${i}`, name: `Group ${i}`, url: `https://facebook.com/groups/g${i}`,
      memberCount: 100, composerType: 'status', active: true, cooldownDaysOverride: null,
      rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
    });
    groupIds.push(g.id);
  }
  store.groups.setAssignments(biz.id, groupIds);

  return { store, scheduler: createScheduler(store), bizId: biz.id, adId: ad.id, groupIds };
}

function logPost(store: Store, o: { groupId: Id; businessId: Id; adId: Id; whenMs: number }) {
  const variantId = store.ads.variants(o.adId)[0]!.id;
  store.log.append({
    queueItemId: null, groupId: o.groupId, businessId: o.businessId, adId: o.adId, variantId,
    outcome: 'posted', postedAt: new Date(o.whenMs).toISOString(),
    fbPostUrl: null, error: null, detail: null, roundId: null,
  });
}

const planOneDay = (s: ReturnType<typeof createScheduler>, seed = 42) =>
  s.plan({ now: new Date(NOW).toISOString(), windowEnd: new Date(NOW + DAY).toISOString(), seed });

test('respects the per-group cooldown boundary', () => {
  const { store, scheduler, bizId, adId, groupIds } = setup({ groups: 2 });
  // Isolate the group cooldown: the per-ad cooldown is exercised separately.
  store.settings.update({ perGroupAdCooldownDays: 0 });
  const [recent, old] = groupIds as [Id, Id];
  logPost(store, { groupId: recent, businessId: bizId, adId, whenMs: NOW - 6 * DAY }); // inside 7d
  logPost(store, { groupId: old, businessId: bizId, adId, whenMs: NOW - 8 * DAY });    // outside 7d

  const plan = planOneDay(scheduler);
  const posted = new Set(plan.posts.map((p) => p.groupId));
  assert.ok(!posted.has(recent), '6 days ago is inside a 7-day cooldown');
  assert.ok(posted.has(old), '8 days ago has cleared a 7-day cooldown');

  const why = plan.exclusions.find((e) => e.groupId === recent);
  assert.equal(why?.reason, 'cooldown');
  store.close();
});

test('per-group cooldown override beats the global setting', () => {
  const { store, scheduler, bizId, adId, groupIds } = setup({ groups: 1 });
  store.settings.update({ perGroupAdCooldownDays: 0 });
  const gid = groupIds[0]!;
  logPost(store, { groupId: gid, businessId: bizId, adId, whenMs: NOW - 3 * DAY });

  assert.equal(planOneDay(scheduler).posts.length, 0, '3 days into the default 7-day cooldown');

  store.groups.update(gid, { cooldownDaysOverride: 2 });
  assert.equal(planOneDay(scheduler).posts.length, 1, 'a 2-day override should clear at 3 days');
  store.close();
});

test('never exceeds the daily cap, counting posts already logged today', () => {
  const { store, scheduler, bizId, adId, groupIds } = setup({ groups: 40 });
  store.settings.update({ dailyCap: 5 });

  assert.equal(planOneDay(scheduler).posts.length, 5);

  // Four already posted today leaves room for exactly one more.
  for (let i = 0; i < 4; i++) {
    logPost(store, { groupId: groupIds[i]!, businessId: bizId, adId, whenMs: Date.parse('2026-09-09T09:00:00.000Z') });
  }
  assert.equal(planOneDay(scheduler).posts.length, 1);
  store.close();
});

test('schedules nothing outside the active-hours window', () => {
  const { store, scheduler } = setup({ groups: 60 });
  store.settings.update({ dailyCap: 40, activeHourStart: 9, activeHourEnd: 17 });

  const plan = scheduler.plan({
    now: new Date(NOW).toISOString(),
    windowEnd: new Date(NOW + 3 * DAY).toISOString(),
    seed: 7,
  });
  assert.ok(plan.posts.length > 0);
  for (const p of plan.posts) {
    const h = localHour(Date.parse(p.scheduledFor), 'UTC');
    assert.ok(h >= 9 && h < 17, `${p.scheduledFor} falls outside 09:00-17:00`);
  }
  store.close();
});

test('gaps between consecutive posts stay inside the configured range', () => {
  const { store, scheduler } = setup({ groups: 60 });
  store.settings.update({ dailyCap: 30, minGapMinutes: 20, maxGapMinutes: 40 });

  const posts = planOneDay(scheduler, 99).posts;
  assert.ok(posts.length > 2, 'need several posts to compare gaps');
  for (let i = 1; i < posts.length; i++) {
    const gapMin = (Date.parse(posts[i]!.scheduledFor) - Date.parse(posts[i - 1]!.scheduledFor)) / 60_000;
    assert.ok(gapMin >= 20 && gapMin <= 40, `gap of ${gapMin} min is outside 20-40`);
  }
  store.close();
});

test('is deterministic for a fixed seed and varies with a different one', () => {
  const { store, scheduler } = setup({ groups: 20 });
  const a = planOneDay(scheduler, 1234);
  const b = planOneDay(scheduler, 1234);
  const c = planOneDay(scheduler, 5678);
  assert.deepEqual(a.posts, b.posts, 'same seed must produce the same plan');
  assert.notDeepEqual(a.posts.map((p) => p.scheduledFor), c.posts.map((p) => p.scheduledFor));
  store.close();
});

test('does not use the same variant for two consecutive posts', () => {
  const { store, scheduler } = setup({ groups: 30, variants: 3 });
  store.settings.update({ dailyCap: 12 });
  const posts = planOneDay(scheduler, 3).posts;
  assert.ok(posts.length > 3);
  for (let i = 1; i < posts.length; i++) {
    assert.notEqual(posts[i]!.variantId, posts[i - 1]!.variantId,
      'consecutive posts must not carry identical text');
  }
  store.close();
});

test('a single variant is still usable (rotation degrades, it does not deadlock)', () => {
  const { store, scheduler } = setup({ groups: 5, variants: 1 });
  const posts = planOneDay(scheduler).posts;
  assert.ok(posts.length > 0, 'one variant must not block scheduling entirely');
  store.close();
});

test('excludes quarantined groups with the right reason', () => {
  const { store, scheduler, groupIds } = setup({ groups: 2 });
  const gid = groupIds[0]!;
  store.groups.update(gid, {
    quarantinedUntil: new Date(NOW + 5 * DAY).toISOString(),
    quarantineReason: 'admin warned us',
  });
  const plan = planOneDay(scheduler);
  assert.ok(!plan.posts.some((p) => p.groupId === gid));
  const why = plan.exclusions.find((e) => e.groupId === gid);
  assert.equal(why?.reason, 'group-quarantined');
  assert.equal(why?.detail, 'admin warned us');
  store.close();
});

test('excludes inactive groups and groups assigned to no business', () => {
  const { store, scheduler, groupIds } = setup({ groups: 3 });
  store.groups.update(groupIds[0]!, { active: false });
  const orphan = store.groups.create({
    fbGroupId: 'orphan', name: 'Orphan', url: 'u', memberCount: null, composerType: 'status',
    active: true, cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null,
    quarantineReason: null, tags: [],
  });

  const plan = planOneDay(scheduler);
  assert.equal(plan.exclusions.find((e) => e.groupId === groupIds[0]!)?.reason, 'group-inactive');
  assert.equal(plan.exclusions.find((e) => e.groupId === orphan.id)?.reason, 'no-assignment');
  store.close();
});

test('the per-ad cooldown blocks a group whose group cooldown has already cleared', () => {
  const { store, scheduler, bizId, adId, groupIds } = setup({ groups: 1 });
  const gid = groupIds[0]!;
  // 10 days ago: past the 7-day group cooldown, still inside the 21-day ad one.
  logPost(store, { groupId: gid, businessId: bizId, adId, whenMs: NOW - 10 * DAY });

  const plan = planOneDay(scheduler);
  assert.equal(plan.posts.length, 0);
  assert.equal(plan.exclusions.find((e) => e.groupId === gid)?.reason, 'ad-cooldown');

  // A second, different ad for the same business unblocks the group.
  const other = store.ads.create({ businessId: bizId, name: 'Second ad', composerType: 'status', active: true });
  store.ads.createVariant({
    adId: other.id, caption: 'different copy', listingTitle: null, listingPriceCents: null,
    listingCategory: null, listingLocation: null, imagePaths: [], weight: 1, active: true,
  });
  const replan = planOneDay(scheduler);
  assert.equal(replan.posts.length, 1);
  assert.equal(replan.posts[0]!.adId, other.id, 'must choose the ad that is not in cooldown');
  store.close();
});

test('will not post a status ad into a marketplace group', () => {
  const { store, scheduler, groupIds } = setup({ groups: 1 });
  const gid = groupIds[0]!;
  store.groups.update(gid, { composerType: 'listing' }); // the only ad is a 'status' ad

  const plan = planOneDay(scheduler);
  assert.equal(plan.posts.length, 0);
  assert.equal(plan.exclusions.find((e) => e.groupId === gid)?.reason, 'no-eligible-ad');
  store.close();
});

test('reports eligible-but-unscheduled groups as daily-cap, not as a rule failure', () => {
  const { store, scheduler } = setup({ groups: 30 });
  store.settings.update({ dailyCap: 3 });
  const plan = planOneDay(scheduler);
  assert.equal(plan.posts.length, 3);
  const capped = plan.exclusions.filter((e) => e.reason === 'daily-cap');
  assert.equal(capped.length, 27, 'every eligible group that missed out should say why');
  store.close();
});

test('a group is never scheduled twice inside its own cooldown', () => {
  const { store, scheduler } = setup({ groups: 3 });
  store.settings.update({ dailyCap: 40 });
  // A 14-day window with only 3 groups and a 7-day cooldown: each group can
  // appear at most twice.
  const plan = scheduler.plan({
    now: new Date(NOW).toISOString(),
    windowEnd: new Date(NOW + 14 * DAY).toISOString(),
    seed: 11,
  });
  const byGroup = new Map<Id, number[]>();
  for (const p of plan.posts) {
    const times = byGroup.get(p.groupId) ?? [];
    times.push(Date.parse(p.scheduledFor));
    byGroup.set(p.groupId, times);
  }
  for (const [groupId, times] of byGroup) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const gapDays = (times[i]! - times[i - 1]!) / DAY;
      assert.ok(gapDays >= 7, `group ${groupId} replanned after only ${gapDays.toFixed(1)} days`);
    }
  }
  store.close();
});

test('plan() mutates nothing; commit() is what writes the queue', () => {
  const { store, scheduler } = setup({ groups: 5 });
  const plan = planOneDay(scheduler);
  assert.equal(store.queue.list().length, 0, 'a dry run must not touch the queue');

  const items = scheduler.commit(plan);
  assert.equal(items.length, plan.posts.length);
  assert.equal(store.queue.list().length, plan.posts.length);
  assert.ok(items.every((i) => i.status === 'pending' && i.runnerMode === 'assisted'));
  store.close();
});
