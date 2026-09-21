/**
 * Only the parts that can be tested without a live browser. The selectors and
 * the composer flows cannot be verified from here — see README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchBlock, isAccountWide, selectBlockText, selectStatusText, isWrongComposerFailure, WRONG_COMPOSER_TAG,
} from './detect.ts';
import { resultAfterPosting, resultBeforeComposing, resultFromError } from './playwright-runner.ts';
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

// --- block detection: where text is read from, and what it means --------------

test('"your post is pending approval" is its own signal, not a group restriction', () => {
  const r = matchBlock('https://www.facebook.com/groups/123', 'Your post is pending approval by an admin.');
  assert.equal(r.kind, 'pending-approval');
  assert.equal(isAccountWide('pending-approval'), false);
});

test('a real block wins over a pending-approval notice on the same page', () => {
  const r = matchBlock('https://www.facebook.com/groups/123', 'Your post is pending\nYou are posting too quickly');
  assert.equal(r.kind, 'rate-limit');
});

test('login-required stops the run like other account-wide blocks', () => {
  assert.equal(isAccountWide('login-required'), true);
  assert.equal(isAccountWide('group-restricted'), false);
});

test('members’ posts in a group feed are never read as a block', () => {
  const text = selectBlockText({
    overlayTexts: [],
    hasFeed: true,
    bodyText: 'Great deals! Slow down and read. Try again later if sold out. Security check done on all cars.',
  });
  assert.equal(matchBlock('https://www.facebook.com/groups/123', text).blocked, false);
});

test('a dialog over a group feed is still read', () => {
  const text = selectBlockText({
    overlayTexts: ["You're Temporarily Blocked\nIt looks like you were misusing this feature."],
    hasFeed: true,
    bodyText: 'ignored',
  });
  assert.equal(matchBlock('https://www.facebook.com/groups/123', text).kind, 'temporary-block');
});

test('a full-page interstitial without a feed is read in full', () => {
  const text = selectBlockText({ overlayTexts: [], hasFeed: false, bodyText: 'Security Check\nPlease solve this puzzle' });
  assert.equal(matchBlock('https://www.facebook.com/some/interstitial', text).kind, 'captcha');
});

test('before composing: a group restriction is reported as blocked with its kind', () => {
  const r = resultBeforeComposing(matchBlock('https://www.facebook.com/groups/1', 'Only admins can post in this group'));
  assert.equal(r?.outcome, 'blocked');
  assert.equal(r?.blockKind, 'group-restricted');
});

test('before composing: an earlier post pending approval does not stop us', () => {
  assert.equal(resultBeforeComposing(matchBlock('https://www.facebook.com/groups/1', 'Your post is pending')), null);
  assert.equal(resultBeforeComposing({ blocked: false }), null);
});

test('after posting: pending approval means the post went out', () => {
  const url = 'https://www.facebook.com/groups/1';
  const r = resultAfterPosting(matchBlock(url, 'Your post is pending approval'), url);
  assert.equal(r.outcome, 'posted');
  assert.equal(r.detail, 'pending admin approval');
  assert.equal(r.fbPostUrl, url);
});

test('after posting: a real block is reported with its kind', () => {
  const r = resultAfterPosting(matchBlock('https://www.facebook.com/checkpoint/9/', ''), 'x');
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.blockKind, 'checkpoint');
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

// --- role="status" toasts ------------------------------------------------------
// Facebook shows some notices (notably "pending approval") as toasts in a
// status region. Those may signal pending-approval ONLY — generic toasts such
// as "Couldn't load comments. Try again later." must never trip the breaker.

test('a pending-approval toast in a status region is recognised', () => {
  const surfaces = { overlayTexts: [], statusTexts: ['Your post is pending approval'], hasFeed: true, bodyText: '' };
  const r = matchBlock('https://www.facebook.com/groups/1', selectBlockText(surfaces), selectStatusText(surfaces));
  assert.equal(r.kind, 'pending-approval');
  assert.match(r.reason ?? '', /status toast/);
});

test('status-region text cannot signal account-wide or group-level kinds', () => {
  for (const toast of [
    "Couldn't load comments. Try again later.",
    'Slow down',
    'Security check',
    "You can't post in this group",
  ]) {
    const r = matchBlock('https://www.facebook.com/groups/1', '', toast);
    assert.equal(r.blocked, false, `status toast must be ignored: ${toast}`);
  }
});

test('a real block in a dialog still beats a pending-approval toast', () => {
  const r = matchBlock('https://www.facebook.com/groups/1', 'You are posting too quickly', 'Your post is pending');
  assert.equal(r.kind, 'rate-limit');
});

test('surfaces without statusTexts still work', () => {
  assert.equal(selectStatusText({ overlayTexts: [], hasFeed: true, bodyText: '' }), '');
});

// --- the buy-and-sell ComposerError --------------------------------------------

const WRONG_COMPOSER_MESSAGE = 'this group shows "Sell Something" but no "Write something…" composer — this '
  + 'looks like a buy-and-sell group — set its composer type to "listing" (Marketplace) in the Groups tab';

test('the buy-and-sell composer error is tagged so the orchestrator can quarantine the group', () => {
  const r = resultFromError(WRONG_COMPOSER_MESSAGE, 'shot.png');
  assert.equal(r.outcome, 'failed');
  assert.ok(r.error?.startsWith(`${WRONG_COMPOSER_TAG}:`));
  assert.equal(r.detail, 'shot.png');
  assert.equal(isWrongComposerFailure(r), true);
});

test('the tag survives the hint being on a later line', () => {
  const r = resultFromError('no status composer\nthis looks like a buy-and-sell group — fix it');
  assert.equal(isWrongComposerFailure(r), true);
  assert.equal(r.error, `${WRONG_COMPOSER_TAG}: no status composer`);
});

test('ordinary errors are not mistaken for a wrong composer type', () => {
  const r = resultFromError('could not find the group composer\nthe page offered: Join, Share');
  assert.equal(r.error, 'could not find the group composer');
  assert.equal(isWrongComposerFailure(r), false);
  // Only failures count — a posted result mentioning the phrase is not one.
  assert.equal(isWrongComposerFailure({ outcome: 'posted', error: WRONG_COMPOSER_MESSAGE }), false);
});
