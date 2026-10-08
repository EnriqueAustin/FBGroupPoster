/**
 * Browser-free tests for the composer helpers. The flows themselves need a live
 * Facebook page and cannot be verified here — see README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Locator } from 'playwright';
import { typeHumanely, isCommentTextboxName, decideStatusOpener, typedTextMismatch } from './composers.ts';

test('typed text that Facebook left alone passes, whatever its emoji and spacing', () => {
  const caption = '📍 Serving the West Coast\n\n📲 WhatsApp/Call: 073 859 5637';
  assert.equal(typedTextMismatch(caption, 'Serving the West Coast\nWhatsApp/Call: 073 859 5637'), null);
});

test('a word turned into a tag of a page is caught', () => {
  const caption = '📍 Serving the West Coast\n\n📲 WhatsApp/Call: 073 859 5637';
  const posted = 'Serving the West Coast To Coast Waterproofing📲 WhatsApp/Call: 073 859 5637';
  assert.match(typedTextMismatch(caption, posted) ?? '', /found "to coast waterproofing whatsapp"/);
});

test('missing trailing words are caught', () => {
  assert.notEqual(typedTextMismatch('book today', 'book'), null);
});

/**
 * Just enough of a Locator to record what typeHumanely presses. `handlesLineBreak`
 * models whether the editor acts on the line-break input event (Facebook's
 * does); a handled one is recorded as '<br>'. When false, every page check
 * (line break, open suggestion list) comes back negative.
 */
function recordingLocator(handlesLineBreak = false): { locator: Locator; keys: string[] } {
  const keys: string[] = [];
  const fake = {
    click: async () => {},
    press: async (key: string) => { keys.push(key); },
    type: async (text: string) => { keys.push(text); },
    evaluate: async () => {
      if (handlesLineBreak) keys.push('<br>');
      return handlesLineBreak;
    },
  };
  return { locator: fake as unknown as Locator, keys };
}

test('typeHumanely breaks lines without pressing a key when the editor allows it', async () => {
  const { locator, keys } = recordingLocator(true);
  await typeHumanely(locator, 'Call\n\nb');
  assert.deepEqual(keys, ['C', 'a', 'l', 'l', '<br>', '<br>', 'b']);
});

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
