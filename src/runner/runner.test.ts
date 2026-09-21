/**
 * Only the parts that can be tested without a live browser. The selectors and
 * the composer flows cannot be verified from here — see README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBlock, isAccountWide } from './detect.ts';
import { decideLoggedIn } from './browser.ts';
import { SELECTORS } from './composers.ts';
import { guessComposerType, parseGroupId, parseMemberCount, mergeDiscovered } from './discover-groups.ts';

test('detects a temporary posting block from page text', () => {
  const r = matchBlock('https://www.facebook.com/groups/123', "You're Temporarily Blocked\nIt looks like you were misusing this feature.");
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'temporary-block');
});

test('detects a checkpoint from the URL alone', () => {
  const r = matchBlock('https://www.facebook.com/checkpoint/1234/', 'anything at all');
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'checkpoint');
});

test('detects being logged out', () => {
  const r = matchBlock('https://www.facebook.com/login/?next=x', 'Log into Facebook');
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'login-required');
});

test('detects a group-level restriction and marks it as not account-wide', () => {
  const r = matchBlock('https://www.facebook.com/groups/123', "Only admins can post in this group");
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'group-restricted');
  assert.equal(isAccountWide('group-restricted'), false);
  assert.equal(isAccountWide('temporary-block'), true);
});

test('a normal group page is not a block', () => {
  const r = matchBlock(
    'https://www.facebook.com/groups/123',
    'Local Buy and Sell\nWrite something...\n1.2K members\nRecent posts',
  );
  assert.equal(r.blocked, false);
});

test('matching is case-insensitive', () => {
  assert.equal(matchBlock('https://x/', 'SECURITY CHECK').blocked, true);
});

test('parses group ids and rejects list pages', () => {
  assert.equal(parseGroupId('https://www.facebook.com/groups/123456789/'), '123456789');
  assert.equal(parseGroupId('https://www.facebook.com/groups/my.group.name/?ref=x'), 'my.group.name');
  assert.equal(parseGroupId('https://www.facebook.com/groups/joins/'), null);
  assert.equal(parseGroupId('https://www.facebook.com/marketplace/'), null);
});

test('parses member counts in the shapes Facebook renders', () => {
  assert.equal(parseMemberCount('1,234 members'), 1234);
  assert.equal(parseMemberCount('3.2K members'), 3200);
  assert.equal(parseMemberCount('1.1M members'), 1_100_000);
  assert.equal(parseMemberCount('12 members'), 12);
  assert.equal(parseMemberCount('no numbers here'), null);
});

test('guesses the listing composer for buy/sell style names', () => {
  assert.equal(guessComposerType('Cape Town Buy and Sell'), 'listing');
  assert.equal(guessComposerType('Pretoria Marketplace'), 'listing');
  assert.equal(guessComposerType('Te Koop Groep'), 'listing');
  assert.equal(guessComposerType('Local Plumbers Network'), 'status');
});

test('merging keeps one row per group and the richer data', () => {
  const merged = mergeDiscovered([
    { fbGroupId: '1', name: 'Group', url: 'u', memberCount: null, composerTypeGuess: 'status' },
    { fbGroupId: '1', name: 'Group One Full Name', url: 'u', memberCount: 500, composerTypeGuess: 'status' },
    { fbGroupId: '2', name: 'Another', url: 'u', memberCount: 10, composerTypeGuess: 'status' },
  ]);
  assert.equal(merged.length, 2);
  const first = merged.find((m) => m.fbGroupId === '1')!;
  assert.equal(first.name, 'Group One Full Name');
  assert.equal(first.memberCount, 500);
});

// --- sign-in detection -------------------------------------------------------
// The bug these cover: Facebook sets the `c_user` cookie as soon as the
// PASSWORD is accepted, while two-factor is still outstanding. Trusting that
// cookie first made the tool declare success mid-2FA, scrape nothing, and close
// the browser window while the user was reaching for their phone.

const signals = (over: Partial<import('./browser.ts').AuthSignals> = {}) => ({
  url: 'https://www.facebook.com/',
  hasLoginForm: false,
  bodyText: 'News Feed',
  hasSessionCookie: true,
  ...over,
});

test('not logged in while a two-factor page is showing, even with the session cookie', () => {
  assert.equal(decideLoggedIn(signals({
    url: 'https://www.facebook.com/two_step_verification/authentication/?next=x',
  })), false);
});

test('not logged in on a checkpoint, even with the session cookie', () => {
  assert.equal(decideLoggedIn(signals({
    url: 'https://www.facebook.com/checkpoint/1234/',
  })), false);
});

test('not logged in on a code-entry screen that has no email field', () => {
  // This is the case the old email-field backstop got wrong.
  assert.equal(decideLoggedIn(signals({
    url: 'https://www.facebook.com/',
    hasLoginForm: false,
    bodyText: 'Enter the code we sent to your phone\nLogin code',
  })), false);
});

test('not logged in when the approve-on-another-device prompt is up', () => {
  assert.equal(decideLoggedIn(signals({
    bodyText: 'Check your notifications on another device',
  })), false);
});

test('not logged in while the password form is visible', () => {
  assert.equal(decideLoggedIn(signals({
    hasLoginForm: true, hasSessionCookie: false,
  })), false);
});

test('not logged in without the session cookie, however clean the page looks', () => {
  assert.equal(decideLoggedIn(signals({ hasSessionCookie: false })), false);
});

test('logged in only once nothing objects and the cookie is present', () => {
  assert.equal(decideLoggedIn(signals()), true);
  assert.equal(decideLoggedIn(signals({
    url: 'https://www.facebook.com/groups/joins/',
    bodyText: 'Your groups\nCape Town Buy and Sell',
  })), true);
});

// --- composer entry patterns -------------------------------------------------
// A real failure showed the page had not finished rendering, but these guard
// the other half: that the wording patterns match what Facebook actually puts
// on screen, including the typographic apostrophe it uses in some locales.

const matchesComposer = (label: string) =>
  SELECTORS.openStatusComposer.some((re) => re.test(label));

test('recognises the common group composer entry points', () => {
  for (const label of [
    'Write something...',
    'Write something to Langebaan Community News & Trade Zone...',
    "What's on your mind, Antonio?",
    'What’s on your mind, Antonio?', // typographic apostrophe
    'Create a public post…',
    'Start a discussion',
    'Skryf iets...',
  ]) {
    assert.ok(matchesComposer(label), `should match: ${label}`);
  }
});

test('does not match unrelated buttons on a group page', () => {
  for (const label of ['Join group', 'Invite', 'Share', 'Members', 'Comment', 'Like']) {
    assert.equal(matchesComposer(label), false, `should not match: ${label}`);
  }
});

// --- photo button patterns ---------------------------------------------------
// A post went out with no image because attachImages targeted an unrelated
// hidden file input elsewhere on the page. Scoping fixed that; these guard the
// wording of the button that mounts the composer's own input.

const matchesPhoto = (label: string) =>
  SELECTORS.addPhoto.some((re) => re.test(label));

test('recognises the composer photo button', () => {
  for (const label of ['Photo/video', 'Photo or video', 'Add Photos', 'Add photo', 'Add image', 'Photos', 'Foto/video']) {
    assert.ok(matchesPhoto(label), `should match: ${label}`);
  }
});

test('the photo button patterns do not match unrelated controls', () => {
  for (const label of ['Post', 'Tag people', 'Feeling/activity', 'Go live', 'Check in']) {
    assert.equal(matchesPhoto(label), false, `should not match: ${label}`);
  }
});
