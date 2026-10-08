/**
 * Idempotent migration runner.
 *
 * Every migration is a function that receives the open database. The applied
 * version is recorded in `schema_version`, so `migrate()` is safe to call on
 * every process start: already-applied steps are skipped.
 *
 * Migration 1 is the base schema (schema.sql, written with IF NOT EXISTS
 * throughout so it is also self-idempotent). Later schema changes get appended
 * as new entries — never edit an existing one, since deployed databases have
 * already recorded it as applied.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  currentVersion as coreCurrentVersion, latestVersion, runMigrations, type Migration,
} from '../../core/migrations.ts';

/**
 * schema.sql sits next to this module in src/, but `tsc` does not copy non-TS
 * files into dist/. Try the compiled-adjacent copy first, then fall back to the
 * source tree so `npm start` works without a separate asset-copy step.
 */
function readSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'schema.sql'),
    join(here, '..', '..', '..', 'src', 'facebook', 'store', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`schema.sql not found; looked in: ${candidates.join(', ')}`);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'base-schema',
    up(db) {
      db.exec(readSchemaSql());
    },
  },
  {
    version: 2,
    name: 'round-posting',
    up(db) {
      // Round (campaign) posting: one ad, every selected group, several times a
      // day. Needs its own pacing knobs because the day-scale cooldowns that
      // govern drip posting are exactly what a round overrides.
      db.exec(`
        ALTER TABLE settings ADD COLUMN rounds_per_day INTEGER NOT NULL DEFAULT 2;
        ALTER TABLE settings ADD COLUMN min_hours_between_rounds INTEGER NOT NULL DEFAULT 3;
        ALTER TABLE settings ADD COLUMN round_min_gap_minutes INTEGER NOT NULL DEFAULT 5;
        ALTER TABLE settings ADD COLUMN round_max_gap_minutes INTEGER NOT NULL DEFAULT 12;
        ALTER TABLE settings ADD COLUMN round_daily_cap INTEGER;
        ALTER TABLE queue_items ADD COLUMN round_id TEXT;
        ALTER TABLE post_log   ADD COLUMN round_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_queue_round ON queue_items (round_id);
        CREATE INDEX IF NOT EXISTS idx_post_log_round ON post_log (round_id, posted_at);
      `);
    },
  },
  {
    version: 3,
    name: 'group-name-lock',
    up(db) {
      // Re-running the group import refreshed every name from Facebook, which
      // also wiped names typed by hand in the Groups tab — the database had no
      // way to tell a scraped name from a human one. This flag records it.
      //
      // DEFAULT 0 on upgrade is deliberate: every existing name is treated as
      // scraped, i.e. exactly how the importer already treated them, so the
      // upgrade itself changes no behaviour. Names edited from here on lock.
      //
      // Added here rather than in schema.sql: fresh installs run migration 1
      // then this one, and a column already present in the base schema would
      // make this ALTER fail with "duplicate column name".
      db.exec(`
        ALTER TABLE groups ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0
          CHECK (name_locked IN (0, 1));
      `);
    },
  },
  {
    version: 4,
    name: 'identities',
    up(db) {
      // Posting as a Facebook Page as well as the personal profile.
      //
      // Groups stay one row per Facebook group, but membership becomes
      // per-identity: a Page has to join each group itself. Every existing
      // group is backfilled as a membership of the profile, and every existing
      // business keeps identity_id NULL (= the profile), so the upgrade itself
      // changes nothing about what gets posted where.
      //
      // The ALTERed REFERENCES columns must default to NULL — SQLite refuses a
      // non-NULL default on an added foreign-key column.
      db.exec(`
        CREATE TABLE identities (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL,
          kind        TEXT    NOT NULL CHECK (kind IN ('profile', 'page')),
          page_url    TEXT,
          fb_page_id  TEXT,
          created_at  TEXT    NOT NULL
        );
        CREATE UNIQUE INDEX idx_identities_one_profile ON identities (kind) WHERE kind = 'profile';

        CREATE TABLE group_memberships (
          group_id          INTEGER NOT NULL REFERENCES groups (id)     ON DELETE CASCADE,
          identity_id       INTEGER NOT NULL REFERENCES identities (id) ON DELETE CASCADE,
          active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          last_seen_at      TEXT,
          quarantined_until TEXT,
          quarantine_reason TEXT,
          PRIMARY KEY (group_id, identity_id)
        );
        CREATE INDEX idx_group_memberships_identity ON group_memberships (identity_id, active);

        ALTER TABLE businesses ADD COLUMN identity_id INTEGER REFERENCES identities (id) ON DELETE SET NULL;
        ALTER TABLE post_log   ADD COLUMN identity_id INTEGER REFERENCES identities (id) ON DELETE SET NULL;
      `);
      const now = new Date().toISOString();
      const profileId = Number(db.prepare(
        "INSERT INTO identities (name, kind, created_at) VALUES ('Personal profile', 'profile', ?)",
      ).run(now).lastInsertRowid);
      db.prepare(`INSERT INTO group_memberships (group_id, identity_id, active, last_seen_at)
        SELECT id, ?, 1, NULL FROM groups`).run(profileId);
      // History before this point was all posted as the profile.
      db.prepare('UPDATE post_log SET identity_id = ?').run(profileId);
    },
  },
];

// Facebook's history lives in the original `schema_version` table: renaming it
// would make every existing database re-run migration 1.
const VERSION_TABLE = 'schema_version';

export const LATEST_SCHEMA_VERSION: number = latestVersion(MIGRATIONS);

/** Highest applied version, or 0 on a database that has never been migrated. */
export function currentVersion(db: Database): number {
  return coreCurrentVersion(db, VERSION_TABLE);
}

/**
 * Applies every pending migration. Returns the versions actually applied.
 * `upTo` stops early — only tests use it, to build a database as an older
 * install had it and then check the upgrade.
 */
export function migrate(db: Database, upTo: number = LATEST_SCHEMA_VERSION): number[] {
  return runMigrations(db, VERSION_TABLE, MIGRATIONS, upTo);
}
