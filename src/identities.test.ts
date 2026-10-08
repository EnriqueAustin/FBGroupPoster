/**
 * Posting as a Page: the upgrade, per-identity imports, planning, the run
 * loop and the API. The browser switch itself needs Facebook; its one pure
 * decision (isActingAs) is tested here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { openStore } from './store/sqlite-store.ts';
import { migrate } from './store/migrate.ts';
import { importGroups } from './bootstrap.ts';
import { createScheduler } from './scheduler/planner.ts';
import { planRound } from './scheduler/rounds.ts';
import { createOrchestrator } from './orchestrator.ts';
import { registerRoutes } from './server/routes.ts';
import { isActingAs } from './runner/identity.ts';
import type { DiscoveredGroup, PostJob, PostResult, Runner, Store } from './domain/contracts.ts';
import type { Id } from './domain/types.ts';

const found = (id: string, name = `Group ${id}`): DiscoveredGroup => ({
  fbGroupId: id, name, url: `https://www.facebook.com/groups/${id}`, memberCount: 10, composerTypeGuess: 'status',
});
const discoverer = (rows: DiscoveredGroup[]) => ({ discover: async () => rows });

function group(store: Store, fbId: string, memberOf?: Id[]) {
  return store.groups.create({
    fbGroupId: fbId, name: `Group ${fbId}`, url: `https://www.facebook.com/groups/${fbId}`,
    memberCount: 10, composerType: 'status', active: true, cooldownDaysOverride: null,
    rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  }, memberOf ? { memberOf } : undefined);
}

/** A business with one ad, posting as a Page, plus one profile-only and one shared group. */
function pageFixture() {
  const store = openStore(':memory:');
  store.settings.update({ timezone: 'UTC', defaultRunnerMode: 'auto' });
  const profile = store.identities.profile();
  const pageId = store.identities.createPage({ name: 'Acme Page', pageUrl: 'https://www.facebook.com/acme' }).id;
  const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null, identityId: pageId });
  const ad = store.ads.create({ businessId: biz.id, name: 'Promo', composerType: 'status', active: true });
  const variant = store.ads.createVariant({
    adId: ad.id, caption: 'hi', listingTitle: null, listingPriceCents: null, listingCategory: null,
    listingLocation: null, imagePaths: [], weight: 1, active: true,
  });
  const profileOnly = group(store, 'p1', [profile.id]).id;
  const shared = group(store, 's1', [profile.id, pageId]).id;
  store.groups.setAssignments(biz.id, [profileOnly, shared]);
  return { store, profile, pageId, bizId: biz.id, adId: ad.id, variantId: variant.id, profileOnly, shared };
}

// --- upgrade -----------------------------------------------------------------

test('upgrading an existing database keeps everything posting as the profile', () => {
  // A database as a pre-identities install had it, with data in it.
  const now = new Date().toISOString();
  const db2 = new Database(':memory:');
  db2.pragma('foreign_keys = ON');
  migrate(db2, 3);
  db2.prepare(`INSERT INTO groups (fb_group_id, name, url, composer_type, created_at)
    VALUES ('old', 'Old group', 'u', 'status', ?)`).run(now);
  db2.prepare(`INSERT INTO businesses (name, created_at) VALUES ('Old biz', ?)`).run(now);
  assert.deepEqual(migrate(db2), [4]);

  const profile = db2.prepare("SELECT * FROM identities WHERE kind = 'profile'").all() as { id: number }[];
  assert.equal(profile.length, 1);
  const m = db2.prepare('SELECT * FROM group_memberships').all() as { identity_id: number; active: number }[];
  assert.equal(m.length, 1, 'the existing group became a profile membership');
  assert.equal(m[0]!.identity_id, profile[0]!.id);
  assert.equal(m[0]!.active, 1);
  const biz = db2.prepare('SELECT identity_id FROM businesses').get() as { identity_id: number | null };
  assert.equal(biz.identity_id, null, 'null = the profile');
  db2.close();
});

test('a fresh store has exactly one profile, and it cannot be removed', () => {
  const store = openStore(':memory:');
  const all = store.identities.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.kind, 'profile');
  assert.throws(() => store.identities.remove(all[0]!.id), /cannot be removed/);
  store.close();
});

// --- import ------------------------------------------------------------------

test('a Page import adds memberships without touching the profile', async () => {
  const store = openStore(':memory:');
  const profile = store.identities.profile();
  const page = store.identities.createPage({ name: 'Acme Page', pageUrl: 'https://www.facebook.com/acme' });
  const mine = group(store, '1').id;          // profile only (default)
  store.groups.update(mine, { active: true, rulesNotes: 'no links' });

  const res = await importGroups(store, discoverer([found('1'), found('2')]), () => {}, page.id);
  assert.equal(res.created, 1, 'group 2 is new');
  assert.equal(res.joined, 2);

  const shared = store.groups.getByFbId('1')!;
  assert.equal(shared.rulesNotes, 'no links', 'curation on the shared row survives');
  assert.ok(store.memberships.get(shared.id, profile.id)?.active, 'profile membership untouched');
  assert.ok(store.memberships.get(shared.id, page.id)?.active);

  const pageOnly = store.groups.getByFbId('2')!;
  assert.equal(store.memberships.get(pageOnly.id, profile.id), null,
    'a group only the Page is in must not become postable by the profile');
  assert.deepEqual(store.groups.list({ identityId: page.id }).map((g) => g.fbGroupId), ['1', '2']);
  assert.deepEqual(store.groups.list({ identityId: profile.id }).map((g) => g.fbGroupId), ['1']);
  store.close();
});

test('re-importing a Page deactivates groups it has left, and only its own', async () => {
  const store = openStore(':memory:');
  const profile = store.identities.profile();
  const page = store.identities.createPage({ name: 'P', pageUrl: 'https://www.facebook.com/p' });
  await importGroups(store, discoverer([found('1'), found('2')]), () => {}, page.id);
  await importGroups(store, discoverer([found('1'), found('2')]), () => {});  // profile in both too

  const res = await importGroups(store, discoverer([found('1')]), () => {}, page.id);
  assert.equal(res.left, 1);
  const g2 = store.groups.getByFbId('2')!.id;
  assert.equal(store.memberships.get(g2, page.id)?.active, false);
  assert.equal(store.memberships.get(g2, profile.id)?.active, true);
  store.close();
});

// --- planning ----------------------------------------------------------------

test('a business posting as a Page is only planned into groups the Page is in', () => {
  const { store, bizId, profileOnly, shared } = pageFixture();
  const plan = createScheduler(store).plan({
    now: '2026-09-10T08:00:00.000Z', windowEnd: '2026-09-11T08:00:00.000Z', seed: 1,
  });
  assert.deepEqual([...new Set(plan.posts.map((p) => p.groupId))], [shared]);
  const ex = plan.exclusions.find((e) => e.groupId === profileOnly && e.businessId === bizId);
  assert.equal(ex?.reason, 'not-a-member');
  store.close();
});

test('switching the business back to the profile restores the profile groups', () => {
  const { store, bizId, profileOnly, shared } = pageFixture();
  store.businesses.update(bizId, { identityId: null });
  const round = planRound(store, { businessId: bizId, now: '2026-09-10T10:00:00.000Z', seed: 1 });
  assert.deepEqual(round.posts.map((p) => p.groupId).sort(), [profileOnly, shared].sort());
  store.close();
});

test('a round skips groups where the Page is quarantined, but not the profile', () => {
  const { store, pageId, bizId, shared, profileOnly } = pageFixture();
  store.memberships.set(shared, pageId, {
    quarantinedUntil: '2099-01-01T00:00:00.000Z', quarantineReason: 'Pages not allowed',
  });
  const round = planRound(store, { businessId: bizId, now: '2026-09-10T10:00:00.000Z', seed: 1 });
  assert.equal(round.posts.length, 0);
  assert.equal(round.exclusions.find((e) => e.groupId === shared)?.reason, 'group-quarantined');

  store.businesses.update(bizId, { identityId: null });
  const asProfile = planRound(store, { businessId: bizId, now: '2026-09-10T10:00:00.000Z', seed: 1 });
  assert.deepEqual(asProfile.posts.map((p) => p.groupId).sort(), [profileOnly, shared].sort());
  store.close();
});

// --- run loop ----------------------------------------------------------------

function runner(result: PostResult): Runner & { jobs: PostJob[] } {
  const jobs: PostJob[] = [];
  return { jobs, async start() {}, async post(j) { jobs.push(j); return result; }, async stop() {} };
}

function queueOne(store: Store, f: ReturnType<typeof pageFixture>, groupId: Id) {
  store.queue.createMany([{
    businessId: f.bizId, groupId, adId: f.adId, variantId: f.variantId,
    scheduledFor: '2026-09-10T10:00:00.000Z', status: 'pending', runnerMode: 'auto', roundId: null,
  }]);
}

const at = () => new Date('2026-09-10T10:05:00.000Z');

test('the runner is told which identity to post as, and the log records it', async () => {
  const f = pageFixture();
  queueOne(f.store, f, f.shared);
  const r = runner({ outcome: 'posted', learnedFbPageId: '1000123' });
  await createOrchestrator({ store: f.store, runner: r, now: at, sleep: async () => {}, log: () => {} }).runDue(5);

  assert.equal(r.jobs[0]?.identity?.id, f.pageId);
  assert.equal(f.store.log.list()[0]?.identityId, f.pageId);
  assert.equal(f.store.identities.get(f.pageId)?.fbPageId, '1000123', 'learned Page id is stored');
  f.store.close();
});

test('an item queued for a group the Page is not in is cancelled, not posted', async () => {
  const f = pageFixture();
  queueOne(f.store, f, f.profileOnly);
  const r = runner({ outcome: 'posted' });
  const summary = await createOrchestrator({ store: f.store, runner: r, now: at, sleep: async () => {}, log: () => {} })
    .runDue(5);
  assert.equal(r.jobs.length, 0);
  assert.equal(summary.attempted, 0);
  assert.equal(f.store.queue.list()[0]?.status, 'cancelled');
  f.store.close();
});

test('a group refusing the Page quarantines the Page there, not the group', async () => {
  const f = pageFixture();
  queueOne(f.store, f, f.shared);
  const r = runner({ outcome: 'blocked', blockKind: 'group-restricted', error: 'Pages cannot post here' });
  await createOrchestrator({ store: f.store, runner: r, now: at, sleep: async () => {}, log: () => {} }).runDue(5);

  assert.equal(f.store.groups.get(f.shared)?.quarantinedUntil, null, 'the profile may still post there');
  assert.ok(f.store.memberships.get(f.shared, f.pageId)?.quarantinedUntil);
  assert.equal(f.store.settings.get().breakerTripped, false);
  f.store.close();
});

// --- the pure switch decision -----------------------------------------------

test('isActingAs only trusts the cookie when it can be verified', () => {
  assert.equal(isActingAs(null, { kind: 'profile', fbPageId: null }), true);
  assert.equal(isActingAs('42', { kind: 'profile', fbPageId: null }), false);
  assert.equal(isActingAs('42', { kind: 'page', fbPageId: '42' }), true);
  assert.equal(isActingAs('41', { kind: 'page', fbPageId: '42' }), false, 'a different Page');
  assert.equal(isActingAs('42', { kind: 'page', fbPageId: null }), false, 'unknown id: switch explicitly');
  assert.equal(isActingAs(null, { kind: 'page', fbPageId: '42' }), false);
});

// --- API ---------------------------------------------------------------------

test('identities API: add a Page, point a business at it, remove it', async () => {
  const store = openStore(':memory:');
  const app = Fastify();
  registerRoutes(app, store, createScheduler(store));
  const json = (r: { payload: string }) => JSON.parse(r.payload);

  const bad = await app.inject({ method: 'POST', url: '/api/identities',
    payload: { name: 'X', pageUrl: 'https://example.com/x' } });
  assert.equal(bad.statusCode, 400, 'only facebook.com addresses');

  const page = json(await app.inject({ method: 'POST', url: '/api/identities',
    payload: { name: 'Acme Page', pageUrl: 'https://www.facebook.com/acme' } }));
  assert.equal(page.kind, 'page');

  const biz = json(await app.inject({ method: 'POST', url: '/api/businesses',
    payload: { name: 'Acme', identityId: page.id } }));
  assert.equal(biz.identityId, page.id);

  const missing = await app.inject({ method: 'PATCH', url: `/api/businesses/${biz.id}`, payload: { identityId: 999 } });
  assert.equal(missing.statusCode, 404);

  const list = json(await app.inject({ method: 'GET', url: '/api/identities' }));
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, 'profile', 'profile first');

  const del = json(await app.inject({ method: 'DELETE', url: `/api/identities/${page.id}` }));
  assert.equal(del.businessesMovedToProfile, 1);
  assert.equal(store.businesses.get(biz.id)?.identityId, null);

  const profileDel = await app.inject({ method: 'DELETE', url: `/api/identities/${store.identities.profile().id}` });
  assert.equal(profileDel.statusCode, 400);
  store.close();
});
