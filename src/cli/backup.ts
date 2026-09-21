/**
 * Snapshot the database.
 *
 * Uses VACUUM INTO rather than copying the file: with WAL journalling most
 * recent writes live in `app.db-wal`, so a plain file copy of `app.db` can be
 * almost empty. VACUUM INTO writes a single consistent file.
 *
 * Keeps the most recent KEEP snapshots and prunes the rest.
 */
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../config.ts';

const KEEP = 20;
const DIR = path.join('data', 'backups');

mkdirSync(DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(DIR, `app-${stamp}.db`);

const db = new Database(DB_PATH, { readonly: false });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

const counts = {
  groups: (db.prepare('SELECT COUNT(*) c FROM groups').get() as { c: number }).c,
  active: (db.prepare('SELECT COUNT(*) c FROM groups WHERE active = 1').get() as { c: number }).c,
  ads: (db.prepare('SELECT COUNT(*) c FROM ads').get() as { c: number }).c,
  posted: (db.prepare("SELECT COUNT(*) c FROM post_log WHERE outcome = 'posted'").get() as { c: number }).c,
};
db.close();

console.log(`Backed up to ${out}`);
console.log(`  ${counts.groups} groups (${counts.active} active) · ${counts.ads} ads · ${counts.posted} posted`);

const snapshots = readdirSync(DIR)
  .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
  .map((f) => ({ f, t: statSync(path.join(DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

for (const old of snapshots.slice(KEEP)) {
  unlinkSync(path.join(DIR, old.f));
  console.log(`  pruned ${old.f}`);
}
