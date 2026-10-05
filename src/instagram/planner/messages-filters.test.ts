import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstNameOf, renderMessage, unknownPlaceholders } from './messages.ts';
import { prefilter, profileFilter, type ProfileFacts } from './filters.ts';
import { DEFAULT_FILTERS } from '../domain/types.ts';

test('firstNameOf takes a real first name and refuses brands', () => {
  assert.equal(firstNameOf('Thandi M 🌸'), 'Thandi');
  assert.equal(firstNameOf('jean-pierre'), 'Jean');
  assert.equal(firstNameOf('  zoë  '), 'Zoë');
  assert.equal(firstNameOf('CAPE TOWN EATS'), null);
  assert.equal(firstNameOf('john123'), null);
  assert.equal(firstNameOf('🌸'), null);
  assert.equal(firstNameOf(null), null);
});

test('renderMessage fills placeholders and tidies a missing name', () => {
  const t = 'Hi {first_name}, saw you like good coffee! I am @{username}-friendly.';
  assert.equal(renderMessage(t, { displayName: 'Sipho Ndlovu', username: 'sipho' }),
    'Hi Sipho, saw you like good coffee! I am @sipho-friendly.');
  assert.equal(renderMessage('Hi {first_name}, welcome', { displayName: null, username: 'x' }), 'Hi, welcome');
  assert.equal(renderMessage('Hey {First_Name}!', { displayName: 'BRAND CO', username: 'x' }), 'Hey!');
});

test('unknownPlaceholders catches typos', () => {
  assert.deepEqual(unknownPlaceholders('Hi {firstname} {username} {first_name}'), ['firstname']);
});

test('prefilter: cheap username checks', () => {
  const ctx = { isKnown: (u: string) => u === 'seen', sourceHandles: ['cafeone'], ownHandle: 'me' };
  assert.equal(prefilter('jane.doe', ctx), null);
  assert.equal(prefilter('seen', ctx), 'already known');
  assert.equal(prefilter('cafeone', ctx), 'is a source account');
  assert.equal(prefilter('me', ctx), 'own account');
  assert.equal(prefilter('bestdeals_shop', ctx), 'looks like a business or bot');
  assert.equal(prefilter('user8374920', ctx), 'looks like a bot');
  assert.equal(prefilter('Has Space', ctx), 'not a valid username');
});

const facts = (over: Partial<ProfileFacts> = {}): ProfileFacts => ({
  isPrivate: false, isBusiness: false, followers: 400, following: 500, bio: '',
  alreadyFollowing: false, followsUs: false, ...over,
});

test('profileFilter applies the campaign filters', () => {
  const f = { ...DEFAULT_FILTERS, skipPrivate: true, minFollowers: 50, excludeBioKeywords: ['crypto'] };
  assert.equal(profileFilter(facts(), f), null);
  assert.equal(profileFilter(facts({ isPrivate: true }), f), 'private account');
  assert.equal(profileFilter(facts({ isBusiness: true }), f), 'business account');
  assert.equal(profileFilter(facts({ followers: 10 }), f), 'fewer than 50 followers');
  assert.equal(profileFilter(facts({ followers: 90_000 }), f), 'more than 5000 followers');
  assert.equal(profileFilter(facts({ following: 7000 }), f), 'follows more than 3000 accounts');
  assert.equal(profileFilter(facts({ bio: 'CRYPTO coach' }), f), 'bio mentions "crypto"');
  const req = { ...DEFAULT_FILTERS, requireBioKeywords: ['paarl', 'wellington'] };
  assert.equal(profileFilter(facts({ bio: 'Mom of 2 | Paarl' }), req), null);
  assert.equal(profileFilter(facts({ bio: 'Joburg' }), req), 'bio has none of the required keywords');
});

test('profileFilter never skips on a fact it could not read', () => {
  const f = { ...DEFAULT_FILTERS, skipPrivate: true, minFollowers: 50 };
  assert.equal(profileFilter(facts({ isPrivate: null, isBusiness: null, followers: null, following: null }), f), null);
});
