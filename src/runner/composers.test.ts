/**
 * Browser-free tests for the composer helpers. The flows themselves need a live
 * Facebook page and cannot be verified here — see README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Locator } from 'playwright';
import { typeHumanely, isCommentTextboxName, decideStatusOpener } from './composers.ts';

/** Just enough of a Locator to record what typeHumanely presses. */
function recordingLocator(): { locator: Locator; keys: string[] } {
  const keys: string[] = [];
  const fake = {
    click: async () => {},
    press: async (key: string) => { keys.push(key); },
    type: async (text: string) => { keys.push(text); },
  };
  return { locator: fake as unknown as Locator, keys };
}

test('typeHumanely puts newlines between lines only, never after the last', async () => {
  const { locator, keys } = recordingLocator();
  await typeHumanely(locator, 'ab\ncd');
  assert.deepEqual(keys, ['a', 'b', 'Shift+Enter', 'c', 'd']);
});

test('typeHumanely types a single line with no newline at all', async () => {
  const { locator, keys } = recordingLocator();
  await typeHumanely(locator, 'a b');
  assert.deepEqual(keys, ['a', 'Space', 'b']);
});

test('typeHumanely treats CRLF as one newline', async () => {
  const { locator, keys } = recordingLocator();
  await typeHumanely(locator, 'a\r\nb');
  assert.deepEqual(keys, ['a', 'Shift+Enter', 'b']);
});

test('typeHumanely keeps a blank line the caption asked for', async () => {
  const { locator, keys } = recordingLocator();
  await typeHumanely(locator, 'a\n\nb');
  assert.deepEqual(keys, ['a', 'Shift+Enter', 'Shift+Enter', 'b']);
});

test('comment and reply boxes are recognised by name', () => {
  for (const name of ['Comment as Antonio Bo', 'comment as someone', 'Write a comment…', 'Reply to Jane', '  Write a reply…']) {
    assert.equal(isCommentTextboxName(name), true, name);
  }
});

test('composer text boxes are not mistaken for comment boxes', () => {
  for (const name of ['', 'Create a public post…', 'Write something…', "What's on your mind?", 'Post a comment in this group']) {
    assert.equal(isCommentTextboxName(name), false, name);
  }
});

test('status opener wins whenever it is present', () => {
  assert.equal(decideStatusOpener(true, null, 3000), 'use-status');
  assert.equal(decideStatusOpener(true, 10_000, 3000), 'use-status');
});

test('a listing-only group fails fast once the grace period passes', () => {
  assert.equal(decideStatusOpener(false, 3000, 3000), 'wrong-composer');
  assert.equal(decideStatusOpener(false, 5000, 3000), 'wrong-composer');
});

test('keeps waiting while nothing, or only a just-seen listing opener, is present', () => {
  assert.equal(decideStatusOpener(false, null, 3000), 'keep-waiting');
  assert.equal(decideStatusOpener(false, 500, 3000), 'keep-waiting');
});
