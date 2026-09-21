/**
 * API tests. These drive the real store and scheduler through Fastify's inject,
 * so they cover validation, wiring and the store mapping in one pass. No socket
 * is opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openStore } from '../store/sqlite-store.ts';
import { createScheduler } from '../scheduler/planner.ts';
import { registerRoutes } from './routes.ts';
import type { Store } from '../domain/contracts.ts';

function build() {
  const store = openStore(':memory:');
  const app = Fastify();
  registerRoutes(app, store, createScheduler(store));
  return { app, store };
}

const json = (res: { payload: string }) => JSON.parse(res.payload);

test('creates a business and applies schema defaults', async () => {
  const { app, store } = build();
  const res = await app.inject({ method: 'POST', url: '/api/businesses', payload: { name: 'Acme' } });
  assert.equal(res.statusCode, 200);
  const biz = json(res);
  assert.equal(biz.name, 'Acme');
  assert.equal(biz.active, true, 'default should survive zod parsing');
  assert.equal(biz.dailyCapShare, null);
  store.close();
});

test('rejects an invalid body with 400 and field detail', async () => {
  const { app, store } = build();
  const res = await app.inject({ method: 'POST', url: '/api/businesses', payload: { name: '' } });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /invalid body/i);
  store.close();
});

test('404s for a business that does not exist', async () => {
  const { app, store } = build();
  const res = await app.inject({ method: 'PATCH', url: '/api/businesses/999', payload: { name: 'x' } });
  assert.equal(res.statusCode, 404);
  store.close();
});

test('bulk group update applies the patch to every id', async () => {
  const { app, store } = build();
  const ids = [1, 2, 3].map((n) => store.groups.create({
    fbGroupId: `g${n}`, name: `G${n}`, url: 'u', memberCount: null, composerType: 'status',
    active: false, cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null,
    quarantineReason: null, tags: [],
  }).id);

  const res = await app.inject({
    method: 'POST', url: '/api/groups/bulk',
    payload: { ids, patch: { active: true, composerType: 'listing' } },
  });
  assert.equal(res.statusCode, 200);
  for (const id of ids) {
    const g = store.groups.get(id)!;
    assert.equal(g.active, true);
    assert.equal(g.composerType, 'listing');
  }
  store.close();
});

test('bulk update rejects an empty id list', async () => {
  const { app, store } = build();
  const res = await app.inject({
    method: 'POST', url: '/api/groups/bulk', payload: { ids: [], patch: { active: true } },
  });
  assert.equal(res.statusCode, 400);
  store.close();
});

test('assignments round-trip and replace rather than append', async () => {
  const { app, store } = build();
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const g1 = store.groups.create({
    fbGroupId: 'a', name: 'A', url: 'u', memberCount: null, composerType: 'status', active: true,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  });
  const g2 = store.groups.create({
    fbGroupId: 'b', name: 'B', url: 'u', memberCount: null, composerType: 'status', active: true,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  });

  await app.inject({ method: 'PUT', url: `/api/businesses/${biz.id}/assignments`, payload: { groupIds: [g1.id, g2.id] } });
  let res = await app.inject({ method: 'GET', url: `/api/businesses/${biz.id}/assignments` });
  assert.deepEqual(json(res).sort(), [g1.id, g2.id].sort());

  await app.inject({ method: 'PUT', url: `/api/businesses/${biz.id}/assignments`, payload: { groupIds: [g2.id] } });
  res = await app.inject({ method: 'GET', url: `/api/businesses/${biz.id}/assignments` });
  assert.deepEqual(json(res), [g2.id]);
  store.close();
});

test('a listing variant without a title is rejected', async () => {
  const { app, store } = build();
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const ad = store.ads.create({ businessId: biz.id, name: 'Ad', composerType: 'listing', active: true });

  const bad = await app.inject({ method: 'POST', url: '/api/variants', payload: { adId: ad.id, caption: 'text' } });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error, /title/i);

  const ok = await app.inject({
    method: 'POST', url: '/api/variants',
    payload: { adId: ad.id, caption: 'text', listingTitle: 'Widget' },
  });
  assert.equal(ok.statusCode, 200);
  store.close();
});

test('settings validation rejects an inverted gap range and hour window', async () => {
  const { app, store } = build();
  const gaps = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { minGapMinutes: 60, maxGapMinutes: 10 } });
  assert.equal(gaps.statusCode, 400);
  const hours = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { activeHourStart: 20, activeHourEnd: 8 } });
  assert.equal(hours.statusCode, 400);
  store.close();
});

test('dry-run writes nothing; commit writes the queue', async () => {
  const { app, store } = build();
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const ad = store.ads.create({ businessId: biz.id, name: 'Ad', composerType: 'status', active: true });
  store.ads.createVariant({
    adId: ad.id, caption: 'hello', listingTitle: null, listingPriceCents: null, listingCategory: null,
    listingLocation: null, imagePaths: [], weight: 1, active: true,
  });
  const g = store.groups.create({
    fbGroupId: 'a', name: 'A', url: 'u', memberCount: null, composerType: 'status', active: true,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  });
  store.groups.setAssignments(biz.id, [g.id]);

  const dry = json(await app.inject({ method: 'POST', url: '/api/plan/dry-run?days=3' }));
  assert.ok(dry.posts.length >= 1);
  assert.equal(store.queue.list().length, 0, 'a dry run must not touch the queue');

  const committed = json(await app.inject({
    method: 'POST', url: '/api/plan/commit?days=3', payload: { replacePending: true },
  }));
  assert.ok(committed.committed >= 1);
  assert.equal(store.queue.list().length, committed.committed);
  store.close();
});

test('commit with the dry run seed queues exactly the reviewed schedule', async () => {
  const { app, store } = build();
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const ad = store.ads.create({ businessId: biz.id, name: 'Ad', composerType: 'status', active: true });
  for (const caption of ['one', 'two', 'three']) {
    store.ads.createVariant({
      adId: ad.id, caption, listingTitle: null, listingPriceCents: null, listingCategory: null,
      listingLocation: null, imagePaths: [], weight: 1, active: true,
    });
  }
  const ids = [1, 2, 3, 4, 5, 6].map((n) => store.groups.create({
    fbGroupId: `g${n}`, name: `G${n}`, url: 'u', memberCount: null, composerType: 'status', active: true,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  }).id);
  store.groups.setAssignments(biz.id, ids);

  const dry = json(await app.inject({ method: 'POST', url: '/api/plan/dry-run?days=3' }));
  assert.equal(typeof dry.seed, 'number', 'the dry run must say which seed it used');
  const committed = json(await app.inject({
    method: 'POST', url: `/api/plan/commit?days=3&seed=${dry.seed}`, payload: {},
  }));
  const pick = (posts: { groupId: number; variantId: number }[]) =>
    posts.map((p) => `${p.groupId}:${p.variantId}`);
  assert.deepEqual(pick(committed.plan.posts), pick(dry.posts));
  store.close();
});

test('committing an empty plan leaves the existing queue alone', async () => {
  const { app, store } = build();
  const item = seedQueue(store, inHours(8));
  // The only group is switched off, so a fresh plan is empty.
  store.groups.update(item.groupId, { active: false });

  const res = json(await app.inject({ method: 'POST', url: '/api/plan/commit?days=3', payload: {} }));
  assert.equal(res.committed, 0);
  assert.equal(store.queue.list().length, 1, 'an empty plan must not wipe the queue');
  store.close();
});

test('clearing the breaker is its own endpoint and leaves other settings alone', async () => {
  const { app, store } = build();
  store.settings.update({ breakerTripped: true, breakerReason: 'checkpoint', dailyCap: 9 });

  const res = json(await app.inject({ method: 'POST', url: '/api/breaker/clear' }));
  assert.equal(res.breakerTripped, false);
  assert.equal(res.breakerReason, null);
  assert.equal(res.dailyCap, 9, 'clearing the breaker must not reset unrelated settings');

  // And it cannot be flipped off through the ordinary settings endpoint.
  store.settings.update({ breakerTripped: true, breakerReason: 'again' });
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { breakerTripped: false } });
  assert.equal(store.settings.get().breakerTripped, true,
    'the settings endpoint must ignore breaker fields');
  store.close();
});

test('summary reports counts the dashboard relies on', async () => {
  const { app, store } = build();
  store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  store.groups.create({
    fbGroupId: 'a', name: 'A', url: 'u', memberCount: null, composerType: 'status', active: true,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  });
  store.groups.create({
    fbGroupId: 'b', name: 'B', url: 'u', memberCount: null, composerType: 'status', active: false,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  });

  const s = json(await app.inject({ method: 'GET', url: '/api/summary' }));
  assert.equal(s.counts.businesses, 1);
  assert.equal(s.counts.groupsTotal, 2);
  assert.equal(s.counts.groupsActive, 1);
  assert.equal(s.settings.dailyCap, 15);
  store.close();
});

// --- due vs pending ----------------------------------------------------------
// The bug these cover: a posting run only touches items that are DUE, but the
// UI enabled its buttons from the PENDING total. With everything scheduled for
// the morning, "Post just one" fired, found nothing, and closed silently.

function seedQueue(store: Store, whenIso: string) {
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
  const ad = store.ads.create({ businessId: biz.id, name: 'Ad', composerType: 'status', active: true });
  const v = store.ads.createVariant({
    adId: ad.id, caption: 'hi', listingTitle: null, listingPriceCents: null, listingCategory: null,
    listingLocation: null, imagePaths: [], weight: 1, active: true,
  });
  const g = store.groups.create({
    fbGroupId: 'a', name: 'A', url: 'u', memberCount: null, composerType: 'status', active: true,
    cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  });
  return store.queue.createMany([{
    businessId: biz.id, groupId: g.id, adId: ad.id, variantId: v.id,
    scheduledFor: whenIso, status: 'pending', runnerMode: 'assisted', roundId: null,
  }])[0]!;
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

test('summary separates due-now from queued-later', async () => {
  const { app, store } = build();
  seedQueue(store, inHours(8)); // tomorrow morning, like a real plan

  const s = json(await app.inject({ method: 'GET', url: '/api/summary' }));
  assert.equal(s.counts.queuePending, 1);
  assert.equal(s.counts.queueDueNow, 0, 'a future post is not due');
  assert.ok(s.nextDueAt, 'the UI needs to be able to say when it will run');
  store.close();
});

test('a past-dated item counts as due now', async () => {
  const { app, store } = build();
  seedQueue(store, inHours(-1));
  const s = json(await app.inject({ method: 'GET', url: '/api/summary' }));
  assert.equal(s.counts.queueDueNow, 1);
  assert.equal(s.nextDueAt, null);
  store.close();
});

test('bring-forward makes the next post immediately due', async () => {
  const { app, store } = build();
  const item = seedQueue(store, inHours(8));

  const moved = json(await app.inject({ method: 'POST', url: '/api/queue/bring-forward' }));
  assert.equal(moved.id, item.id);
  assert.ok(moved.scheduledFor <= new Date().toISOString());

  const s = json(await app.inject({ method: 'GET', url: '/api/summary' }));
  assert.equal(s.counts.queueDueNow, 1);
  store.close();
});

test('bring-forward refuses when nothing is waiting', async () => {
  const { app, store } = build();
  const res = await app.inject({ method: 'POST', url: '/api/queue/bring-forward' });
  assert.equal(res.statusCode, 400);
  store.close();
});
