/**
 * Running as two identities at once: a round as a Page beside a round as the
 * profile. Each identity is its own job lane and Chrome profile, a run only
 * takes its own identity's posts, and neither run's setup touches the other's
 * queue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openStore } from './store/sqlite-store.ts';
import { planRound, commitRound } from './scheduler/rounds.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createJobRunner } from '../core/jobs.ts';
import { profileDirFor, DEFAULT_PROFILE_DIRNAME } from '../core/browser.ts';
import type { PostJob, PostResult, Runner, Store } from './domain/contracts.ts';
import type { Id } from './domain/types.ts';

function group(store: Store, fbId: string, memberOf: Id[]) {
  return store.groups.create({
    fbGroupId: fbId, name: `Group ${fbId}`, url: `https://www.facebook.com/groups/${fbId}`,
    memberCount: 10, composerType: 'status', active: true, cooldownDaysOverride: null,
    rulesNotes: '', quarantinedUntil: null, quarantineReason: null, tags: [],
  }, { memberOf });
}

function business(store: Store, name: string, identityId: Id | null) {
  const biz = store.businesses.create({ name, active: true, dailyCapShare: null, identityId });
  const ad = store.ads.create({ businessId: biz.id, name: `${name} promo`, composerType: 'status', active: true });
  const variant = store.ads.createVariant({
    adId: ad.id, caption: `${name} says hi`, listingTitle: null, listingPriceCents: null, listingCategory: null,
    listingLocation: null, imagePaths: [], weight: 1, active: true,
  });
  return { id: biz.id, adId: ad.id, variantId: variant.id };
}

/** A personal business and a Page business, both in two shared groups. */
function fixture() {
  const store = openStore(':memory:');
  store.settings.update({ timezone: 'UTC', defaultRunnerMode: 'auto', activeHourStart: 0, activeHourEnd: 24 });
  const profile = store.identities.profile();
  const page = store.identities.createPage({ name: 'Acme Page', pageUrl: 'https://www.facebook.com/acme' });
  const mine = business(store, 'Personal', null);
  const acme = business(store, 'Acme', page.id);
  const g1 = group(store, 'g1', [profile.id, page.id]).id;
  const g2 = group(store, 'g2', [profile.id, page.id]).id;
  store.groups.setAssignments(mine.id, [g1, g2]);
  store.groups.setAssignments(acme.id, [g1, g2]);
  return { store, profile, page, mine, acme, g1, g2 };
}

function queue(store: Store, b: { id: Id; adId: Id; variantId: Id }, groupId: Id, roundId: string | null = null) {
  return store.queue.createMany([{
    businessId: b.id, groupId, adId: b.adId, variantId: b.variantId,
    scheduledFor: '2026-09-10T10:00:00.000Z', status: 'pending', runnerMode: 'auto', roundId,
  }])[0]!;
}

function runner(post: (j: PostJob) => PostResult | Promise<PostResult> = () => ({ outcome: 'posted' })) {
  const jobs: PostJob[] = [];
  const r: Runner & { jobs: PostJob[] } = {
    jobs, async start() {}, async post(j) { jobs.push(j); return post(j); }, async stop() {},
  };
  return r;
}

const at = () => new Date('2026-09-10T10:05:00.000Z');

// --- job lanes ---------------------------------------------------------------

test('jobs in different lanes run side by side; a second in the same lane is refused', async () => {
  const jobs = createJobRunner();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });

  jobs.start('post-run', () => held, { key: 'identity-1', label: 'Me' });
  jobs.start('post-run', () => held, { key: 'identity-2', label: 'Acme Page' });
  assert.equal(jobs.running().length, 2);
  assert.throws(() => jobs.start('bootstrap', () => held, { key: 'identity-2', label: 'Acme Page' }),
    /already running/);
  assert.equal(jobs.laneBusy('identity-1'), true);

  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(jobs.running().length, 0);
  assert.equal(jobs.laneBusy('identity-1'), false);
});

// --- browser profiles --------------------------------------------------------

test('each Page gets its own Chrome profile; the profile keeps the original one', () => {
  const root = path.join('x', 'proj');
  assert.equal(profileDirFor({ id: 1, kind: 'profile' }, root), path.join(root, DEFAULT_PROFILE_DIRNAME));
  assert.equal(profileDirFor(undefined, root), path.join(root, DEFAULT_PROFILE_DIRNAME));
  const a = profileDirFor({ id: 2, kind: 'page' }, root);
  const b = profileDirFor({ id: 3, kind: 'page' }, root);
  assert.notEqual(a, path.join(root, DEFAULT_PROFILE_DIRNAME));
  assert.notEqual(a, b);
});

// --- the queue ---------------------------------------------------------------

test('nextDue and clearRounds can be limited to some businesses', () => {
  const f = fixture();
  queue(f.store, f.mine, f.g1, 'round-a');
  queue(f.store, f.acme, f.g2, 'round-b');
  const now = '2026-09-10T10:05:00.000Z';

  assert.equal(f.store.queue.nextDue(now, { businessIds: [f.acme.id] })?.businessId, f.acme.id);
  assert.equal(f.store.queue.nextDue(now, { businessIds: [] }), null);

  assert.equal(f.store.queue.clearRounds({ businessIds: [f.acme.id] }), 1);
  assert.deepEqual(f.store.queue.list().map((q) => q.businessId), [f.mine.id], "the profile's round is untouched");
  f.store.close();
});

// --- the run loop ------------------------------------------------------------

test('a run as one identity only posts that identity\'s items', async () => {
  const f = fixture();
  queue(f.store, f.mine, f.g1);
  queue(f.store, f.acme, f.g2);

  const r = runner();
  await createOrchestrator({
    store: f.store, runner: r, now: at, sleep: async () => {}, log: () => {}, identityId: f.page.id,
  }).runDue(5);

  assert.deepEqual(r.jobs.map((j) => j.identity?.id), [f.page.id]);
  const left = f.store.queue.list().find((q) => q.businessId === f.mine.id);
  assert.equal(left?.status, 'pending', "the profile's post is left for the profile's run");
  f.store.close();
});

test('a breaker tripped by the other run stops this one before its next post', async () => {
  const f = fixture();
  queue(f.store, f.acme, f.g1);
  queue(f.store, f.acme, f.g2);

  const r = runner(() => {
    // The profile's run, in the other browser, hits a checkpoint meanwhile.
    f.store.settings.update({ breakerTripped: true, breakerReason: 'checkpoint' });
    return { outcome: 'posted' };
  });
  const summary = await createOrchestrator({
    store: f.store, runner: r, now: at, sleep: async () => {}, log: () => {}, identityId: f.page.id,
  }).runDue(5);

  assert.equal(r.jobs.length, 1);
  assert.equal(summary.stoppedBecause, 'breaker');
  f.store.close();
});

test('isStopRequested ends the run without a handle on the orchestrator', async () => {
  const f = fixture();
  queue(f.store, f.acme, f.g1);
  queue(f.store, f.acme, f.g2);
  let stop = false;
  const r = runner(() => { stop = true; return { outcome: 'skipped' }; });
  const summary = await createOrchestrator({
    store: f.store, runner: r, now: at, sleep: async () => {}, log: () => {},
    identityId: f.page.id, isStopRequested: () => stop,
  }).runDue(5);
  assert.equal(r.jobs.length, 1);
  assert.equal(summary.stoppedBecause, 'stopped');
  f.store.close();
});

// --- planning a second round -------------------------------------------------

test('a round leaves out groups another identity\'s running round is about to post to', () => {
  const f = fixture();
  const now = '2026-09-10T10:00:00.000Z';
  const first = planRound(f.store, { businessId: f.mine.id, now });
  commitRound(f.store, first);
  assert.equal(first.posts.length, 2);

  const second = planRound(f.store, { businessId: f.acme.id, now });
  assert.notEqual(second.roundId, first.roundId, 'same minute, different business, different round');
  assert.equal(second.posts.length, 0);
  assert.ok(second.exclusions.every((e) => /another identity/.test(e.detail ?? '')));
  f.store.close();
});

test('another identity\'s queued round counts towards the daily ceiling', () => {
  const f = fixture();
  const g3 = group(f.store, 'g3', [f.page.id]).id;
  const g4 = group(f.store, 'g4', [f.page.id]).id;
  f.store.groups.setAssignments(f.acme.id, [g3, g4]);
  f.store.settings.update({ roundDailyCap: 3 });
  const now = '2026-09-10T10:00:00.000Z';

  commitRound(f.store, planRound(f.store, { businessId: f.mine.id, now }));
  const second = planRound(f.store, { businessId: f.acme.id, now });
  assert.equal(second.posts.length, 1, '3 allowed, 2 already queued by the profile');
  assert.ok(second.exclusions.some((e) => e.reason === 'round-daily-cap'));
  f.store.close();
});
