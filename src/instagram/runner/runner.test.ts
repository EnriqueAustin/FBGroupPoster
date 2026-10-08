/**
 * The runner's judgements, tested without a browser.
 *
 * Everything the Instagram runner decides — is this session signed in, has
 * Instagram pushed back, is this href a person, how many followers is "12.3K"
 * — is a pure function fed by a thin scraping layer. Those functions are what
 * breaks when Instagram changes, and they are all testable here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayNameFromRow, handleFromHref, handlesFromHrefs, isPlausibleHandle, normaliseHandle,
  parseCount, peopleFromRows, profileFactsFrom, shortcodeFromHref, shortcodesFromHrefs,
  type RawProfile,
} from './parse.ts';
import { decideLoggedIn } from './auth.ts';
import { isTerminal, matchIgBlock, selectBlockText } from './detect.ts';
import { classifyReply, matchThreadToLeads } from './check.ts';
import { profileFilter } from '../planner/filters.ts';
import { DEFAULT_FILTERS } from '../domain/types.ts';

test('follower counts parse in every shape Instagram shows them', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1 234'), 1234);
  assert.equal(parseCount('987'), 987);
  assert.equal(parseCount('12.3K'), 12_300);
  assert.equal(parseCount('12.3k followers'), 12_300);
  assert.equal(parseCount('1.2m'), 1_200_000);
  assert.equal(parseCount('3B'), 3_000_000_000);
  // A plain grouped number must not be read as a decimal.
  assert.equal(parseCount('1,234,567'), 1_234_567);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount('no digits here'), null);
});

test('a profile href is one segment and not one of Instagram’s own sections', () => {
  assert.equal(handleFromHref('/thandi.m/'), 'thandi.m');
  assert.equal(handleFromHref('https://www.instagram.com/Thandi_M/'), 'thandi_m');
  assert.equal(handleFromHref('/p/CxYz12345/'), null);
  assert.equal(handleFromHref('/explore/tags/coffee/'), null);
  assert.equal(handleFromHref('/direct/t/12345/'), null);
  assert.equal(handleFromHref('/accounts/edit/'), null);
  assert.equal(handleFromHref('/reels/audio/123/'), null);
  assert.equal(handleFromHref(null), null);
  assert.equal(handleFromHref('not a url at all'), null);
});

test('post shortcodes come off post, reel and tv links, newest first and deduplicated', () => {
  assert.equal(shortcodeFromHref('/p/CxYz12345/'), 'CxYz12345');
  assert.equal(shortcodeFromHref('/reel/AbCdE_12/'), 'AbCdE_12');
  assert.equal(shortcodeFromHref('/tv/XyZ9876/'), 'XyZ9876');
  assert.equal(shortcodeFromHref('/thandi.m/'), null);
  assert.deepEqual(
    shortcodesFromHrefs(['/p/AAAAA/', '/thandi.m/', '/p/AAAAA/', '/reel/BBBBB/', null]),
    ['AAAAA', 'BBBBB'],
  );
});

test('handles and usernames normalise to the form the leads table is keyed on', () => {
  assert.equal(normaliseHandle('@Thandi.M'), 'thandi.m');
  assert.equal(normaliseHandle(' thandi_m/ '), 'thandi_m');
  assert.ok(isPlausibleHandle('thandi.m'));
  assert.ok(!isPlausibleHandle('.leading'));
  assert.ok(!isPlausibleHandle('trailing.'));
  assert.ok(!isPlausibleHandle('has spaces'));
  assert.ok(!isPlausibleHandle('x'.repeat(31)));
  assert.deepEqual(handlesFromHrefs(['/a_one/', '/p/C1/', '/a_one/', '/b_two/']), ['a_one', 'b_two']);
});

test('a display name is the row line that is neither the handle nor a button', () => {
  assert.equal(displayNameFromRow('thandi.m\nThandi M \u{1F338}\nFollow', 'thandi.m'), 'Thandi M \u{1F338}');
  assert.equal(displayNameFromRow('Follow\nthandi.m\nThandi M', 'thandi.m'), 'Thandi M');
  // Rows with nothing but the handle and buttons are common and harmless.
  assert.equal(displayNameFromRow('thandi.m\nFollowing', 'thandi.m'), null);
  assert.equal(displayNameFromRow('thandi.m\n@thandi.m\nFollow', 'thandi.m'), null);
  assert.equal(displayNameFromRow('', 'thandi.m'), null);
});

test('scraped rows become people, in document order, without duplicates', () => {
  const people = peopleFromRows([
    { href: '/thandi.m/', text: 'thandi.m\nThandi M\nFollow' },
    { href: '/p/CxYz12345/', text: 'a post, not a person' },
    { href: '/thandi.m/', text: 'thandi.m\nThandi M\nFollow' },
    { href: '/sipho_k/', text: 'sipho_k\nSipho K' },
    { href: null, text: 'no href' },
  ]);
  assert.deepEqual(people, [
    { username: 'thandi.m', displayName: 'Thandi M' },
    { username: 'sipho_k', displayName: 'Sipho K' },
  ]);
});

const rawProfile = (over: Partial<RawProfile> = {}): RawProfile => ({
  headerText: 'thandi.m\nThandi M\n312 posts 840 followers 455 following',
  buttonLabels: ['Follow', 'Message'],
  followersTitle: null,
  followingTitle: null,
  followersText: '840 followers',
  followingText: '455 following',
  bioText: 'Mum of two. Cape Town.',
  categoryText: null,
  saysPrivate: false,
  ...over,
});

test('profile facts read the exact count in preference to the abbreviated one', () => {
  const facts = profileFactsFrom(rawProfile({ followersTitle: '12,431', followersText: '12.4K followers' }));
  assert.equal(facts.followers, 12_431);
  assert.equal(facts.following, 455);
});

test('a professional account is recognised by its category line or contact buttons', () => {
  assert.equal(profileFactsFrom(rawProfile()).isBusiness, null, 'unknown, not false');
  assert.equal(profileFactsFrom(rawProfile({ categoryText: 'Restaurant' })).isBusiness, true);
  assert.equal(
    profileFactsFrom(rawProfile({ buttonLabels: ['Follow', 'Email', 'Directions'] })).isBusiness,
    true,
  );
});

test('"Follow back" and "Following" are read as the states they are', () => {
  const followsUs = profileFactsFrom(rawProfile({ buttonLabels: ['Follow Back', 'Message'] }));
  assert.equal(followsUs.followsUs, true);
  assert.equal(followsUs.alreadyFollowing, false);

  const already = profileFactsFrom(rawProfile({ buttonLabels: ['Following', 'Message'] }));
  assert.equal(already.alreadyFollowing, true);

  const requested = profileFactsFrom(rawProfile({ buttonLabels: ['Requested'] }));
  assert.equal(requested.alreadyFollowing, true, 'a pending request is not a fresh follow');
});

test('a private profile is read as private, and a fact we cannot read never skips', () => {
  const priv = profileFactsFrom(rawProfile({
    headerText: 'thandi.m\nThis account is private\nFollow this account to see their photos.',
    saysPrivate: false,
  }));
  assert.equal(priv.isPrivate, true);

  // isBusiness unknown + skipBusiness on = kept, because the filter only
  // excludes what it knows is wrong.
  const unknown = profileFactsFrom(rawProfile());
  assert.equal(profileFilter(unknown, { ...DEFAULT_FILTERS, skipBusiness: true }), null);
  assert.equal(
    profileFilter(profileFactsFrom(rawProfile({ categoryText: 'Shop' })), DEFAULT_FILTERS),
    'business account',
  );
});

test('sign-in needs the session cookie AND nothing else objecting', () => {
  const signals = {
    url: 'https://www.instagram.com/',
    hasLoginForm: false,
    bodyText: 'Your feed',
    hasSessionCookie: true,
  };
  assert.equal(decideLoggedIn(signals), true);

  // The cookie alone is not enough: Instagram sets sessionid while 2FA is
  // still outstanding, and declaring success there wrecks the run.
  assert.equal(decideLoggedIn({ ...signals, url: 'https://www.instagram.com/accounts/login/two_factor' }), false);
  assert.equal(decideLoggedIn({ ...signals, bodyText: 'Enter the 6-digit code we sent' }), false);
  assert.equal(decideLoggedIn({ ...signals, hasLoginForm: true }), false);
  assert.equal(decideLoggedIn({ ...signals, url: 'https://www.instagram.com/challenge/' }), false);
  assert.equal(decideLoggedIn({ ...signals, hasSessionCookie: false }), false);
});

test('block signals match, most serious first', () => {
  assert.equal(matchIgBlock('https://www.instagram.com/', 'Action Blocked').kind, 'action-blocked');
  assert.equal(
    matchIgBlock('https://www.instagram.com/', 'We restrict certain activity to protect our community').kind,
    'action-blocked',
  );
  assert.equal(
    matchIgBlock('https://www.instagram.com/', 'Please wait a few minutes before you try again').kind,
    'rate-limit',
  );
  assert.equal(matchIgBlock('https://www.instagram.com/challenge/', '').kind, 'challenge');
  assert.equal(matchIgBlock('https://www.instagram.com/accounts/suspended/', '').kind, 'account-disabled');
  assert.equal(matchIgBlock('https://www.instagram.com/accounts/login/', '').kind, 'login-required');

  // A suspended account also says "temporarily blocked" on some screens; the
  // more serious kind has to win so the UI does not invite a retry.
  const both = matchIgBlock(
    'https://www.instagram.com/accounts/suspended/',
    'Your account has been temporarily blocked',
  );
  assert.equal(both.kind, 'account-disabled');
  assert.ok(isTerminal('account-disabled'));
  assert.ok(!isTerminal('rate-limit'));

  assert.equal(matchIgBlock('https://www.instagram.com/thandi.m/', 'Thandi M\n840 followers').blocked, false);
});

test('only Instagram’s own text can trip the breaker, never a caption', () => {
  // A caption saying "try again later" must not stop the run.
  const caption = selectBlockText({
    overlayTexts: [],
    hasForeignContent: true,
    bodyText: 'Sold out! Try again later \u{1F614}',
  });
  assert.equal(matchIgBlock('https://www.instagram.com/p/CxYz1/', caption).blocked, false);

  // The same words in a toast are Instagram talking to us.
  const toast = selectBlockText({
    overlayTexts: ['Please wait a few minutes before you try again.'],
    hasForeignContent: true,
    bodyText: 'a post full of comments',
  });
  assert.equal(matchIgBlock('https://www.instagram.com/p/CxYz1/', toast).kind, 'rate-limit');

  // A full-page screen has no foreign content, so its body counts.
  const fullPage = selectBlockText({
    overlayTexts: [],
    hasForeignContent: false,
    bodyText: 'Help us confirm it is you',
  });
  assert.equal(matchIgBlock('https://www.instagram.com/', fullPage).kind, 'challenge');
});

test('a reply that says "not interested" in any of its wordings is an opt-out', () => {
  for (const text of [
    'Not interested thanks',
    'no thanks',
    'Please stop messaging me',
    "don't message me again",
    'unsubscribe',
    'how did you get my details?',
    'this is spam',
  ]) {
    assert.equal(classifyReply(text), 'opt-out', text);
  }

  for (const text of ['Yes please!', 'How much is it?', 'Sure, send me the details', '']) {
    assert.equal(classifyReply(text), 'reply', text);
  }
});

test('an inbox thread matches a lead only when it is unambiguous', () => {
  const candidates = [
    { id: 1, username: 'thandi.m', displayName: 'Thandi M' },
    { id: 2, username: 'sipho_k', displayName: 'Sipho K' },
    { id: 3, username: 'other_one', displayName: 'Thandi M' },
  ];

  // A handle in the row wins outright.
  assert.equal(
    matchThreadToLeads({ title: 'sipho_k', username: 'sipho_k' }, candidates)?.id,
    2,
  );
  // Usually there is only a display name.
  assert.equal(
    matchThreadToLeads({ title: 'Sipho K', username: null }, candidates)?.id,
    2,
  );
  // Two waiting leads share a display name: match nothing, leave it to the
  // human. Stopping the wrong sequence is worse than stopping none.
  assert.equal(matchThreadToLeads({ title: 'Thandi M', username: null }, candidates), null);
  assert.equal(matchThreadToLeads({ title: 'Nobody At All', username: null }, candidates), null);
  assert.equal(matchThreadToLeads({ title: '', username: null }, candidates), null);
});
