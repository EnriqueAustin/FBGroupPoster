import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './sqlite-store.ts';
import type { Store } from '../domain/contracts.ts';

function fixture(): { store: Store; businessId: number; groupId: number; adId: number; variantId: number } {
  const store = openStore(':memory:');
  const business = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const group = store.groups.create({
    fbGroupId: '1001', name: 'Local Buy & Sell', url: 'https://facebook.com/groups/1001',
    memberCount: 5000, composerType: 'listing', active: true, cooldownDaysOverride: null,
    rulesNotes: 'No links', quarantinedUntil: null, quarantineReason: null, tags: ['local'],
  });
  const ad = store.ads.create({ businessId: business.id, name: 'Spring promo', composerType: 'listing', active: true });
  const variant = store.ads.createVariant({
    adId: ad.id, caption: 'Great deal', listingTitle: 'Widget', listingPriceCents: 19900,
    listingCategory: 'Home', listingLocation: 'Cape Town', imagePaths: ['data/media/a.jpg'],
    weight: 1, active: true,
  });
  return { store, businessId: business.id, groupId: group.id, adId: ad.id, variantId: variant.id };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test('round-trips a group including JSON and nullable columns', () => {
  const { store, groupId } = fixture();
  const g = store.groups.get(groupId)!;
  assert.equal(g.fbGroupId, '1001');
  assert.equal(g.composerType, 'listing');
  assert.equal(g.active, true);
  assert.deepEqual(g.tags, ['local']);
  assert.equal(g.cooldownDaysOverride, null);
  assert.equal(g.memberCount, 5000);
  store.close();
});

test('partial update leaves unmentioned columns alone', () => {
  const { store, groupId } = fixture();
  const updated = store.groups.update(groupId, { active: false });
  assert.equal(updated.active, false);
  assert.equal(updated.rulesNotes, 'No links', 'rulesNotes must survive an unrelated patch');
  assert.deepEqual(updated.tags, ['local']);
  store.close();
});

test('upsertByFbId creates then updates', () => {
  const { store } = fixture();
  const base = {
    fbGroupId: '2002', name: 'New Group', url: 'https://facebook.com/groups/2002',
    memberCount: 10, composerType: 'status' as const, active: false,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null,
    quarantineReason: null, tags: [],
  };
  const first = store.groups.upsertByFbId(base);
  assert.equal(first.created, true);
  const second = store.groups.upsertByFbId({ ...base, name: 'Renamed' });
  assert.equal(second.created, false);
  assert.equal(second.group.id, first.group.id, 'must not create a duplicate row');
  assert.equal(second.group.name, 'Renamed');
  store.close();
});

test('setAssignments replaces prior assignments rather than appending', () => {
  const { store, businessId, groupId } = fixture();
  const other = store.groups.create({
    fbGroupId: '3003', name: 'Other', url: 'u', memberCount: null, composerType: 'status',
    active: true, cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null,
    quarantineReason: null, tags: [],
  });
  store.groups.setAssignments(businessId, [groupId, other.id]);
  assert.deepEqual(store.groups.assignments(businessId).sort(), [groupId, other.id].sort());
  store.groups.setAssignments(businessId, [other.id]);
  assert.deepEqual(store.groups.assignments(businessId), [other.id]);
  store.close();
});

test('groups.list filters by business through the join', () => {
  const { store, businessId, groupId } = fixture();
  assert.equal(store.groups.list({ businessId }).length, 0);
  store.groups.setAssignments(businessId, [groupId]);
  const listed = store.groups.list({ businessId, activeOnly: true });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, groupId);
  store.close();
});

test('cooldown lookups ignore non-posted outcomes', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const common = { queueItemId: null, groupId, businessId, adId, variantId, fbPostUrl: null, error: null, detail: null, roundId: null };
  store.log.append({ ...common, outcome: 'failed', postedAt: daysAgo(1) });
  store.log.append({ ...common, outcome: 'skipped', postedAt: daysAgo(2) });
  assert.equal(store.log.lastPostToGroup(groupId), null,
    'a failed or skipped attempt must not start a cooldown');

  store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(3) });
  const last = store.log.lastPostToGroup(groupId);
  assert.ok(last);
  assert.equal(last.outcome, 'posted');
  store.close();
});

test('lastPostToGroup returns the most recent posted entry', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const common = { queueItemId: null, groupId, businessId, adId, variantId, fbPostUrl: null, error: null, detail: null, roundId: null };
  store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(10) });
  store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(2) });
  store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(6) });
  const last = store.log.lastPostToGroup(groupId)!;
  assert.equal(last.postedAt, store.log.list({ groupId })[0]!.postedAt);
  assert.ok(new Date(last.postedAt).getTime() > new Date(daysAgo(3)).getTime());
  store.close();
});

test('lastPostOfAdToGroup is scoped to the ad', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const otherAd = store.ads.create({ businessId, name: 'Other ad', composerType: 'status', active: true });
  const common = { queueItemId: null, groupId, businessId, variantId, fbPostUrl: null, error: null, detail: null, roundId: null };
  store.log.append({ ...common, adId: otherAd.id, outcome: 'posted', postedAt: daysAgo(1) });
  assert.equal(store.log.lastPostOfAdToGroup(groupId, adId), null,
    'another ad in the same group must not trigger this ad-specific cooldown');
  store.log.append({ ...common, adId, outcome: 'posted', postedAt: daysAgo(5) });
  assert.ok(store.log.lastPostOfAdToGroup(groupId, adId));
  store.close();
});

test('countPostedBetween is half-open so adjacent days do not double count', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const common = { queueItemId: null, groupId, businessId, adId, variantId, fbPostUrl: null, error: null, detail: null, roundId: null };
  const dayStart = '2026-09-09T00:00:00.000Z';
  const dayEnd = '2026-09-10T00:00:00.000Z';
  store.log.append({ ...common, outcome: 'posted', postedAt: dayStart });          // inside
  store.log.append({ ...common, outcome: 'posted', postedAt: '2026-09-09T23:59:59.000Z' }); // inside
  store.log.append({ ...common, outcome: 'posted', postedAt: dayEnd });            // next day
  store.log.append({ ...common, outcome: 'failed', postedAt: '2026-09-09T12:00:00.000Z' }); // not a post
  assert.equal(store.log.countPostedBetween(dayStart, dayEnd), 2);
  store.close();
});

test('nextDue returns the earliest non-terminal item at or before now', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const base = { businessId, groupId, adId, variantId, runnerMode: 'assisted' as const, roundId: null };
  store.queue.createMany([
    { ...base, scheduledFor: daysAgo(-1), status: 'pending' }, // future
    { ...base, scheduledFor: daysAgo(1), status: 'pending' },
    { ...base, scheduledFor: daysAgo(2), status: 'posted' },   // terminal, must be ignored
  ]);
  const due = store.queue.nextDue(new Date().toISOString())!;
  assert.equal(due.status, 'pending');
  assert.equal(due.scheduledFor, daysAgo(1).slice(0, 10) + due.scheduledFor.slice(10));
  store.close();
});

test('clearPending removes only pending rows', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const base = { businessId, groupId, adId, variantId, runnerMode: 'assisted' as const, roundId: null };
  store.queue.createMany([
    { ...base, scheduledFor: daysAgo(1), status: 'pending' },
    { ...base, scheduledFor: daysAgo(1), status: 'posted' },
    { ...base, scheduledFor: daysAgo(1), status: 'failed' },
  ]);
  assert.equal(store.queue.clearPending(), 1);
  assert.equal(store.queue.list().length, 2);
  store.close();
});

test('settings seed from defaults and survive a partial update', () => {
  const { store } = fixture();
  const s = store.settings.get();
  assert.equal(s.dailyCap, 15);
  assert.equal(s.perGroupCooldownDays, 7);
  assert.equal(s.breakerTripped, false);

  const updated = store.settings.update({ breakerTripped: true, breakerReason: 'checkpoint' });
  assert.equal(updated.breakerTripped, true);
  assert.equal(updated.breakerReason, 'checkpoint');
  assert.equal(updated.dailyCap, 15, 'unrelated settings must be preserved');
  store.close();
});

test('post_log survives deletion of the queue item it came from', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const [item] = store.queue.createMany([
    { businessId, groupId, adId, variantId, scheduledFor: daysAgo(1), status: 'pending', runnerMode: 'assisted', roundId: null },
  ]);
  store.log.append({
    queueItemId: item!.id, groupId, businessId, adId, variantId,
    outcome: 'posted', postedAt: daysAgo(1), fbPostUrl: null, error: null, detail: null, roundId: null,
  });
  store.queue.clearPending();
  const entries = store.log.list({ groupId });
  assert.equal(entries.length, 1, 'replanning must never erase posting history');
  assert.equal(entries[0]!.queueItemId, null);
  store.close();
});

// --- deletion ---------------------------------------------------------------

test('queue.remove deletes only the ids given', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const base = { businessId, groupId, adId, variantId, runnerMode: 'assisted' as const, roundId: null };
  const items = store.queue.createMany([
    { ...base, scheduledFor: daysAgo(1), status: 'pending' },
    { ...base, scheduledFor: daysAgo(2), status: 'cancelled' },
    { ...base, scheduledFor: daysAgo(3), status: 'failed' },
  ]);

  assert.equal(store.queue.remove([items[1]!.id]), 1);
  assert.deepEqual(
    store.queue.list().map((q) => q.id).sort((a, b) => a - b),
    [items[0]!.id, items[2]!.id].sort((a, b) => a - b),
  );
  assert.equal(store.queue.remove([]), 0, 'an empty selection must be a no-op, not "delete everything"');
  store.close();
});

test('queue.removeByStatus sweeps a whole status and leaves the rest', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const base = { businessId, groupId, adId, variantId, runnerMode: 'assisted' as const, roundId: null };
  store.queue.createMany([
    { ...base, scheduledFor: daysAgo(1), status: 'cancelled' },
    { ...base, scheduledFor: daysAgo(2), status: 'cancelled' },
    { ...base, scheduledFor: daysAgo(3), status: 'pending' },
  ]);

  assert.equal(store.queue.removeByStatus(['cancelled']), 2);
  assert.deepEqual(store.queue.list().map((q) => q.status), ['pending']);
  assert.equal(store.queue.removeByStatus([]), 0);
  store.close();
});

test('deleting a queue item keeps the record that it posted', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const [item] = store.queue.createMany([{
    businessId, groupId, adId, variantId,
    scheduledFor: daysAgo(1), status: 'posted', runnerMode: 'auto', roundId: 'round-1',
  }]);
  store.log.append({
    queueItemId: item!.id, groupId, businessId, adId, variantId,
    outcome: 'posted', postedAt: daysAgo(1),
    fbPostUrl: 'https://facebook.com/x', error: null, detail: null, roundId: 'round-1',
  });

  store.queue.remove([item!.id]);

  // ON DELETE SET NULL, not CASCADE: losing the plan must never lose the
  // history the cooldowns are computed from.
  const history = store.log.list();
  assert.equal(history.length, 1);
  assert.equal(history[0]!.queueItemId, null);
  assert.ok(store.log.lastPostToGroup(groupId), 'the cooldown must survive');
  store.close();
});

test('log.remove and removeByOutcome delete history rows', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const common = {
    queueItemId: null, groupId, businessId, adId, variantId,
    fbPostUrl: null, error: null, detail: null, roundId: null,
  };
  const failed = store.log.append({ ...common, outcome: 'failed', postedAt: daysAgo(1) });
  store.log.append({ ...common, outcome: 'failed', postedAt: daysAgo(2) });
  store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(3) });

  assert.equal(store.log.remove([failed.id]), 1);
  assert.equal(store.log.list().length, 2);

  assert.equal(store.log.removeByOutcome(['failed']), 1);
  assert.deepEqual(store.log.list().map((l) => l.outcome), ['posted']);
  assert.equal(store.log.remove([]), 0);
  assert.equal(store.log.removeByOutcome([]), 0);
  store.close();
});

test('deleting a posted row frees that group from its cooldown', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const posted = store.log.append({
    queueItemId: null, groupId, businessId, adId, variantId,
    outcome: 'posted', postedAt: daysAgo(1),
    fbPostUrl: null, error: null, detail: null, roundId: null,
  });
  assert.ok(store.log.lastPostToGroup(groupId));

  // This is exactly why the API makes you confirm it by name.
  store.log.remove([posted.id]);
  assert.equal(store.log.lastPostToGroup(groupId), null);
  store.close();
});

test('countByOutcome counts all history, with no list() cap', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const common = {
    queueItemId: null, groupId, businessId, adId, variantId,
    fbPostUrl: null, error: null, detail: null, roundId: null,
  };
  for (let i = 0; i < 1005; i++) store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(1) });
  store.log.append({ ...common, outcome: 'failed', postedAt: daysAgo(1) });
  assert.equal(store.log.countByOutcome('posted'), 1005);
  assert.equal(store.log.countByOutcome('failed'), 1);
  assert.equal(store.log.countByOutcome('blocked'), 0);
  store.close();
});

test('countIdsWithOutcome checks only the given ids', () => {
  const { store, businessId, groupId, adId, variantId } = fixture();
  const common = {
    queueItemId: null, groupId, businessId, adId, variantId,
    fbPostUrl: null, error: null, detail: null, roundId: null,
  };
  const posted = store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(1) });
  const failed = store.log.append({ ...common, outcome: 'failed', postedAt: daysAgo(1) });
  store.log.append({ ...common, outcome: 'posted', postedAt: daysAgo(2) }); // not asked about

  assert.equal(store.log.countIdsWithOutcome([failed.id], 'posted'), 0);
  assert.equal(store.log.countIdsWithOutcome([failed.id, posted.id, 9999], 'posted'), 1);
  assert.equal(store.log.countIdsWithOutcome([], 'posted'), 0);
  store.close();
});
