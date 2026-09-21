/**
 * Media GC tests. Everything runs in a fresh temp directory — never the real
 * data/media — and the clock is passed in, so the grace period and the
 * diagnostics age filter are exercised without sleeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, utimesSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store/sqlite-store.ts';
import {
  deleteMediaFiles, findOldDiagnostics, findUnusedMedia, mediaKey, referencedImagePaths,
} from './media-gc.ts';

const DAY = 86_400_000;

/** A temp project root with data/media inside, like the real layout. */
function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'media-gc-'));
  const media = path.join(root, 'data', 'media');
  mkdirSync(path.join(media, 'diagnostics'), { recursive: true });
  const put = (rel: string, body = 'x', ageDays = 0) => {
    const full = path.join(media, rel);
    writeFileSync(full, body);
    const t = new Date(Date.now() - ageDays * DAY);
    utimesSync(full, t, t);
    return full;
  };
  return { root, media, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

const names = (xs: Array<{ path: string }>) => xs.map((f) => path.basename(f.path)).sort();

test('keeps images referenced by active AND inactive variants; lists the rest', async () => {
  const s = sandbox();
  const store = openStore(':memory:');
  try {
    s.put('1-active.png', 'aaaa', 2);
    s.put('2-inactive.png', 'bb', 2);
    s.put('3-orphan.png', 'ccc', 2);

    const biz = store.businesses.create({ name: 'Acme', active: true, dailyCapShare: null });
    // The inactive variant lives on an inactive ad too: neither flag may hide it.
    const live = store.ads.create({ businessId: biz.id, name: 'Live', composerType: 'status', active: true });
    const dead = store.ads.create({ businessId: biz.id, name: 'Dead', composerType: 'status', active: false });
    const base = {
      listingTitle: null, listingPriceCents: null, listingCategory: null, listingLocation: null, weight: 1,
    };
    store.ads.createVariant({ ...base, adId: live.id, caption: 'a', active: true,
      imagePaths: [path.join(s.media, '1-active.png')] });
    store.ads.createVariant({ ...base, adId: dead.id, caption: 'b', active: false,
      imagePaths: [path.join(s.media, '2-inactive.png')] });

    const unused = await findUnusedMedia({ mediaDir: s.media, referenced: referencedImagePaths(store) });
    assert.deepEqual(names(unused), ['3-orphan.png']);
    assert.equal(unused[0]!.bytes, 3);

    const res = await deleteMediaFiles(s.media, unused);
    assert.deepEqual(res, { deleted: 1, bytes: 3, skipped: [] });
    assert.ok(existsSync(path.join(s.media, '1-active.png')));
    assert.ok(existsSync(path.join(s.media, '2-inactive.png')));
    assert.ok(!existsSync(path.join(s.media, '3-orphan.png')));
  } finally { store.close(); s.done(); }
});

test('Windows and POSIX forms of a relative stored path both match the file', async () => {
  const s = sandbox();
  try {
    s.put('10-win.png', 'x', 2);
    s.put('11-posix.png', 'x', 2);
    s.put('12-abs.png', 'x', 2);
    s.put('13-orphan.png', 'x', 2);
    const unused = await findUnusedMedia({
      mediaDir: s.media,
      baseDir: s.root,
      referenced: [
        'data\\media\\10-win.png',       // stored by a Windows server
        'data/media/11-posix.png',        // stored by a POSIX server
        path.join(s.media, '12-abs.png'), // absolute
      ],
    });
    assert.deepEqual(names(unused), ['13-orphan.png']);
    assert.equal(mediaKey('data\\media\\a.png', s.root), mediaKey('data/media/a.png', s.root));
  } finally { s.done(); }
});

test('skips the diagnostics folder, subfolders and fresh uploads', async () => {
  const s = sandbox();
  try {
    s.put('old.png', 'x', 2);
    s.put('just-uploaded.png', 'x', 0); // an unsaved ad editor may be about to reference it
    s.put(path.join('diagnostics', 'fail.png'), 'x', 90);
    mkdirSync(path.join(s.media, 'somedir'));
    const unused = await findUnusedMedia({ mediaDir: s.media, referenced: [] });
    assert.deepEqual(names(unused), ['old.png']);

    const noGrace = await findUnusedMedia({ mediaDir: s.media, referenced: [], graceMs: 0 });
    assert.deepEqual(names(noGrace), ['just-uploaded.png', 'old.png']);
  } finally { s.done(); }
});

test('a missing media dir is simply empty', async () => {
  const s = sandbox();
  try {
    const nowhere = path.join(s.root, 'nope');
    assert.deepEqual(await findUnusedMedia({ mediaDir: nowhere, referenced: [] }), []);
    assert.deepEqual(await findOldDiagnostics({ mediaDir: nowhere }), []);
  } finally { s.done(); }
});

test('diagnostics are filtered by age, default 30 days', async () => {
  const s = sandbox();
  try {
    s.put(path.join('diagnostics', 'ancient.png'), 'xx', 45);
    s.put(path.join('diagnostics', 'ancient.txt'), 'y', 31);
    s.put(path.join('diagnostics', 'recent.png'), 'x', 5);
    s.put('top-level-old.png', 'x', 90); // not a diagnostics file
    assert.deepEqual(names(await findOldDiagnostics({ mediaDir: s.media })), ['ancient.png', 'ancient.txt']);
    assert.deepEqual(names(await findOldDiagnostics({ mediaDir: s.media, olderThanDays: 40 })), ['ancient.png']);
    assert.deepEqual(names(await findOldDiagnostics({ mediaDir: s.media, olderThanDays: 1 })),
      ['ancient.png', 'ancient.txt', 'recent.png']);

    const res = await deleteMediaFiles(s.media, await findOldDiagnostics({ mediaDir: s.media }));
    assert.equal(res.deleted, 2);
    assert.equal(res.bytes, 3);
    assert.ok(existsSync(path.join(s.media, 'diagnostics', 'recent.png')));
  } finally { s.done(); }
});

test('never deletes outside the media dir, whatever path it is handed', async () => {
  const s = sandbox();
  try {
    const outside = path.join(s.root, 'precious.db');
    writeFileSync(outside, 'keep me');
    mkdirSync(path.join(s.media, 'nested'));
    const nested = path.join(s.media, 'nested', 'deep.png');
    writeFileSync(nested, 'x');

    const res = await deleteMediaFiles(s.media, [
      { path: path.join(s.media, '..', '..', 'precious.db'), bytes: 7 },
      { path: outside, bytes: 7 },
      { path: nested, bytes: 1 }, // inside, but not directly in media or diagnostics
      { path: path.join(s.media, 'diagnostics', '..', '..', '..', 'precious.db'), bytes: 7 },
    ]);
    assert.equal(res.deleted, 0);
    assert.equal(res.skipped.length, 4);
    assert.ok(existsSync(outside));
    assert.ok(existsSync(nested));
  } finally { s.done(); }
});

test('a traversal path in a variant does not protect or expose anything outside', async () => {
  const s = sandbox();
  try {
    s.put('orphan.png', 'x', 2);
    writeFileSync(path.join(s.root, 'secret.txt'), 's');
    const unused = await findUnusedMedia({
      mediaDir: s.media, baseDir: s.root,
      referenced: ['data/media/../../secret.txt', '..\\..\\..\\etc\\passwd'],
    });
    // Only files actually inside the media dir are ever listed.
    assert.deepEqual(names(unused), ['orphan.png']);
  } finally { s.done(); }
});

test('symlinks in the media dir are ignored, not followed', async (t) => {
  const s = sandbox();
  try {
    const target = path.join(s.root, 'target.png');
    writeFileSync(target, 'x');
    try {
      symlinkSync(target, path.join(s.media, 'link.png'));
    } catch {
      // Creating symlinks on Windows needs Developer Mode or admin rights.
      t.skip('symlinks not permitted on this machine');
      return;
    }
    const unused = await findUnusedMedia({ mediaDir: s.media, referenced: [], graceMs: 0 });
    assert.deepEqual(names(unused), []);
    const res = await deleteMediaFiles(s.media, [{ path: path.join(s.media, 'link.png'), bytes: 1 }]);
    assert.equal(res.deleted, 0);
    assert.ok(existsSync(target));
  } finally { s.done(); }
});
