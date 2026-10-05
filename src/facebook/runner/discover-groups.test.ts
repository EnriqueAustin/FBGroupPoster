/**
 * Group-name cleaning for the import. The bug these cover: notification and
 * activity cards link to groups too, so a real group was saved as
 * "UnreadAn admin approved your photo in Cape Town Adverts.12h" — and because
 * merging kept the LONGER name, the junk beat the real one every time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGroupName, looksLikeNotification, mergeDiscovered, pickGroupName } from './discover-groups.ts';
import type { DiscoveredGroup } from '../domain/contracts.ts';

test('the reported junk name is recognised as a notification', () => {
  assert.equal(cleanGroupName('UnreadAn admin approved your photo in Cape Town Adverts.12h'), null);
});

test('notification phrases are rejected', () => {
  for (const s of [
    'Jane Doe commented on your post in Durban Swap Shop',
    'John posted in Pretoria Buy & Sell',
    'Mary invited you to join Joburg Classifieds',
    'An admin approved your post',
  ]) assert.equal(cleanGroupName(s), null, s);
});

test('trailing relative times are rejected', () => {
  for (const s of ['Cape Town Adverts.12h', 'Something · 3d', 'Thing 2w', 'Update Just now', 'Post 5 minutes ago']) {
    assert.ok(looksLikeNotification(s), s);
  }
});

test('ordinary group names survive, whitespace tidied', () => {
  assert.equal(cleanGroupName('  Cape Town   Adverts '), 'Cape Town Adverts');
  for (const s of ['Unread Books Club', 'Durban 4x4', 'Area51 Collectors', 'Buy & Sell 24/7', 'Class of 2010']) {
    assert.equal(cleanGroupName(s), s, s);
  }
  assert.equal(cleanGroupName('   '), null);
});

test('pickGroupName prefers the clean name, and the real name over a wrapped one', () => {
  assert.equal(pickGroupName('Cape Town Adverts', 'UnreadAn admin approved your photo in Cape Town Adverts.12h'),
    'Cape Town Adverts');
  assert.equal(pickGroupName('UnreadAn admin approved your photo in Cape Town Adverts.12h', 'Cape Town Adverts'),
    'Cape Town Adverts');
  // Name wrapped in unrecognised chrome: the contained, shorter one wins.
  assert.equal(pickGroupName('Visit Cape Town Adverts', 'Cape Town Adverts'), 'Cape Town Adverts');
  // A prefix extension is a truncated label, so the fuller name still wins.
  assert.equal(pickGroupName('Group', 'Group One Full Name'), 'Group One Full Name');
});

test('merging no longer lets notification text win', () => {
  const row = (name: string): DiscoveredGroup =>
    ({ fbGroupId: '42', name, url: 'u', memberCount: null, composerTypeGuess: 'status' });
  const merged = mergeDiscovered([
    row('UnreadAn admin approved your photo in Cape Town Adverts.12h'),
    row('Cape Town Adverts'),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.name, 'Cape Town Adverts');
  // The guess follows the winning name ("Adverts" has no listing hint).
  assert.equal(merged[0]!.composerTypeGuess, 'status');
});
