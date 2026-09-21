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

interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

/**
 * schema.sql sits next to this module in src/, but `tsc` does not copy non-TS
 * files into dist/. Try the compiled-adjacent copy first, then fall back to the
 * source tree so `npm start` works without a separate asset-copy step.
 */
function readSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'schema.sql'),
    join(here, '..', '..', 'src', 'store', 'schema.sql'),
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
];

export const LATEST_SCHEMA_VERSION: number =
  MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);

/** Highest applied version, or 0 on a database that has never been migrated. */
export function currentVersion(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const row = db
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_version')
    .get();
  return row?.version ?? 0;
}

/** Applies every pending migration. Returns the versions actually applied. */
export function migrate(db: Database): number[] {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return [];

  const record = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  );
  // One transaction per migration: a failure half-way leaves the earlier ones
  // committed and correctly recorded, rather than silently rolling them back.
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name, new Date().toISOString());
    })();
  }
  return pending.map((m) => m.version);
}
