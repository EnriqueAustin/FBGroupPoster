/**
 * Re-import behaviour: curation is preserved, names are refreshed — which is
 * also what repairs junk names an older scraper saved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store/sqlite-store.ts';
import { importGroups } from './bootstrap.ts';
import type { DiscoveredGroup, GroupDiscoverer } from './domain/contracts.ts';

const discoverer = (rows: DiscoveredGroup[]): GroupDiscoverer => ({ discover: async () => rows });

const JUNK = 'UnreadAn admin approved your photo in Cape Town Adverts.12h';

function seedJunk() {
  const store = openStore(':memory:');
  const g = store.groups.create({
    fbGroupId: '42', name: JUNK, url: 'https://www.facebook.com/groups/42', memberCount: null,
    composerType: 'listing', active: true, cooldownDaysOverride: 5, rulesNotes: 'no links',
    quarantinedUntil: null, quarantineReason: null, tags: ['ct'],
  });
  return { store, id: g.id };
}

test('re-import repairs a junk name and keeps curation', async () => {
  const { store, id } = seedJunk();
  const res = await importGroups(store, discoverer([{
    fbGroupId: '42', name: 'Cape Town Adverts', url: 'https://www.facebook.com/groups/42',
    memberCount: 900, composerTypeGuess: 'status',
  }]));
  assert.deepEqual(res, { found: 1, created: 0, updated: 1 });
  const g = store.groups.get(id)!;
  assert.equal(g.name, 'Cape Town Adverts');
  assert.equal(g.memberCount, 900);
  assert.equal(g.composerType, 'listing', 'curation must survive');
  assert.equal(g.active, true);
  assert.equal(g.cooldownDaysOverride, 5);
  assert.deepEqual(g.tags, ['ct']);
  store.close();
});

test('an incoming junk name never overwrites the stored one', async () => {
  const store = openStore(':memory:');
  const g = store.groups.create({
    fbGroupId: '7', name: 'Durban Swap Shop', url: 'u', memberCount: null, composerType: 'status',
    active: false, cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null,
    quarantineReason: null, tags: [],
  });
  await importGroups(store, discoverer([{
    fbGroupId: '7', name: 'Jane commented on a post in Durban Swap Shop.3d', url: 'u',
    memberCount: null, composerTypeGuess: 'status',
  }]));
  assert.equal(store.groups.get(g.id)!.name, 'Durban Swap Shop');
  store.close();
});
