/**
 * Re-import behaviour: curation is preserved, names are refreshed (unless a
 * human typed them, which locks them) — refreshing is
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

// --- hand-edited names -------------------------------------------------------

function seed(store: ReturnType<typeof openStore>, fbGroupId: string, name: string) {
  return store.groups.create({
    fbGroupId, name, url: `u${fbGroupId}`, memberCount: null, composerType: 'status',
    active: false, cooldownDaysOverride: null, rulesNotes: '', quarantinedUntil: null,
    quarantineReason: null, tags: [],
  }).id;
}

const incoming = (fbGroupId: string, name: string): DiscoveredGroup => ({
  fbGroupId, name, url: `u${fbGroupId}`, memberCount: 123, composerTypeGuess: 'status',
});

test('re-import leaves a hand-edited (locked) name alone', async () => {
  const store = openStore(':memory:');
  const id = seed(store, '1', 'Joburg Classifieds');
  // What PATCH /api/groups/:id does when the user renames it in the Groups tab.
  store.groups.update(id, { name: 'JHB - best for furniture' });

  await importGroups(store, discoverer([incoming('1', 'Joburg Classifieds')]));
  const g = store.groups.get(id)!;
  assert.equal(g.name, 'JHB - best for furniture', 'a human edit must survive re-import');
  assert.equal(g.nameLocked, true, 'import must not unlock');
  assert.equal(g.memberCount, 123, 'the rest of the row still refreshes');
  store.close();
});

test('re-import still refreshes an unlocked name and does not lock it', async () => {
  const store = openStore(':memory:');
  const id = seed(store, '2', 'Old FB Name');
  await importGroups(store, discoverer([incoming('2', 'New FB Name')]));
  const g = store.groups.get(id)!;
  assert.equal(g.name, 'New FB Name');
  assert.equal(g.nameLocked, false, 'a scraped name must stay refreshable next time');
  store.close();
});

test('unlocking a name hands it back to the importer', async () => {
  const store = openStore(':memory:');
  const id = seed(store, '3', 'Scraped');
  store.groups.update(id, { name: 'Typed' });
  store.groups.update(id, { nameLocked: false });
  await importGroups(store, discoverer([incoming('3', 'Scraped Again')]));
  assert.equal(store.groups.get(id)!.name, 'Scraped Again');
  store.close();
});

test('a junk unlocked name is repaired while a locked one next to it is kept', async () => {
  const { store, id: junkId } = seedJunk();
  const lockedId = seed(store, '9', 'Somewhere');
  store.groups.update(lockedId, { name: 'My label' });
  await importGroups(store, discoverer([
    { ...incoming('42', 'Cape Town Adverts'), url: 'https://www.facebook.com/groups/42' },
    incoming('9', 'Somewhere'),
  ]));
  assert.equal(store.groups.get(junkId)!.name, 'Cape Town Adverts');
  assert.equal(store.groups.get(lockedId)!.name, 'My label');
  store.close();
});
