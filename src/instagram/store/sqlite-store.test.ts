import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openIgStore } from './sqlite-store.ts';
import { LATEST_IG_SCHEMA_VERSION, migrateIg } from './migrate.ts';
import { migrate as migrateFb } from '../../facebook/store/migrate.ts';
import { DEFAULT_FILTERS, DEFAULT_IG_SETTINGS } from '../domain/types.ts';
import type { NewIgCampaign } from '../domain/contracts.ts';

const campaign = (over: Partial<NewIgCampaign> = {}): NewIgCampaign => ({
  name: 'Paarl coffee', active: true, sources: ['@CafeOne', 'cafe_two'], postsPerSource: 1,
  maxLeadsPerPost: 50, harvestLikers: true, harvestCommenters: true,
  dmDelayMinHours: 24, dmDelayMaxHours: 48, filters: DEFAULT_FILTERS, ...over,
});

const person = (username: string) => ({
  username, displayName: null, source: 'liker' as const, sourceHandle: 'cafeone', sourcePostUrl: null,
});

test('campaign round-trips, with sources normalised', () => {
  const s = openIgStore(':memory:');
  const c = s.campaigns.create(campaign());
  assert.deepEqual(c.sources, ['cafeone', 'cafe_two']);
  assert.equal(c.harvestCommenters, true);
  assert.deepEqual(c.filters, DEFAULT_FILTERS);
  const u = s.campaigns.update(c.id, { active: false, filters: { ...DEFAULT_FILTERS, skipPrivate: true } });
  assert.equal(u.active, false);
  assert.equal(u.filters.skipPrivate, true);
});

test('a username is a lead once, ever — across campaigns and case', () => {
  const s = openIgStore(':memory:');
  const a = s.campaigns.create(campaign());
  const b = s.campaigns.create(campaign({ name: 'Other' }));
  const at = '2026-10-06T08:00:00.000Z';

  const first = s.leads.addHarvested(a.id, [person('Jane.Doe'), person('bob')], at);
  assert.equal(first.added.length, 2);
  assert.equal(first.added[0]!.username, 'jane.doe');

  const second = s.leads.addHarvested(b.id, [person('@JANE.DOE'), person('bob'), person('new_one')], at);
  assert.equal(second.added.length, 1);
  assert.equal(second.duplicates, 2);
  assert.equal(s.leads.getByUsername('jane.doe')!.campaignId, a.id, 'original campaign kept');
  assert.equal(s.leads.hasUsername('@Bob'), true);
});

test('a campaign with leads cannot be deleted', () => {
  const s = openIgStore(':memory:');
  const c = s.campaigns.create(campaign());
  s.leads.addHarvested(c.id, [person('x')], '2026-10-06T08:00:00.000Z');
  assert.throws(() => s.campaigns.remove(c.id), /deactivate it instead/);
  const empty = s.campaigns.create(campaign({ name: 'Empty' }));
  s.campaigns.remove(empty.id);
  assert.equal(s.campaigns.get(empty.id), null);
});

test('countBetween counts what reached Instagram, not skips', () => {
  const s = openIgStore(':memory:');
  const rec = (outcome: 'ok' | 'failed' | 'skipped' | 'blocked', at: string) =>
    s.actions.record({ kind: 'follow', outcome, leadId: null, campaignId: null, at, detail: null });
  rec('ok', '2026-10-06T08:00:00.000Z');
  rec('failed', '2026-10-06T09:00:00.000Z');
  rec('skipped', '2026-10-06T10:00:00.000Z');
  rec('blocked', '2026-10-06T11:00:00.000Z');
  rec('ok', '2026-10-07T08:00:00.000Z');
  assert.equal(s.actions.countBetween('follow', '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z'), 3);
  assert.equal(s.actions.countBetween('dm', '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z'), 0);
});

test('settings store only overrides and default the rest', () => {
  const s = openIgStore(':memory:');
  assert.deepEqual(s.settings.get(), DEFAULT_IG_SETTINGS);
  s.settings.update({ dailyDmCap: 5 });
  assert.equal(s.settings.get().dailyDmCap, 5);
  assert.equal(s.settings.get().dailyFollowCap, DEFAULT_IG_SETTINGS.dailyFollowCap);
  s.settings.tripBreaker('action blocked', '2026-10-06T08:00:00.000Z');
  assert.equal(s.settings.get().breakerTripped, true);
  s.settings.clearBreaker();
  assert.equal(s.settings.get().breakerTripped, false);
  assert.equal(s.settings.get().dailyDmCap, 5, 'clearing the breaker keeps other overrides');
});

test('IG migrations live beside FB ones without touching them', () => {
  const db = new Database(':memory:');
  migrateFb(db);
  const fbBefore = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
  assert.deepEqual(migrateIg(db), [1]);
  assert.deepEqual(migrateIg(db), [], 'idempotent');
  const fbAfter = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
  const ig = db.prepare('SELECT MAX(version) AS v FROM ig_schema_version').get() as { v: number };
  assert.equal(fbAfter.v, fbBefore.v);
  assert.equal(ig.v, LATEST_IG_SCHEMA_VERSION);
});
