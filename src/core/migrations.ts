/**
 * Idempotent migration runner, shared by every module.
 *
 * Each module keeps its own ordered list of migrations and its own version
 * table, so Facebook and Instagram can evolve their tables independently in
 * the one database file. The applied version is recorded per table, so
 * `runMigrations()` is safe to call on every process start: already-applied
 * steps are skipped.
 *
 * Never edit a migration that has shipped — deployed databases have already
 * recorded it as applied. Append a new one instead.
 */
import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

/** Highest applied version, or 0 on a database that has never been migrated. */
export function currentVersion(db: Database, table: string): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const row = db
    .prepare<[], { version: number | null }>(`SELECT MAX(version) AS version FROM ${table}`)
    .get();
  return row?.version ?? 0;
}

/**
 * Applies every pending migration. Returns the versions actually applied.
 * `upTo` stops early — only tests use it, to build a database as an older
 * install had it and then check the upgrade.
 */
export function runMigrations(
  db: Database,
  table: string,
  migrations: readonly Migration[],
  upTo: number = Infinity,
): number[] {
  const from = currentVersion(db, table);
  const pending = migrations.filter((m) => m.version > from && m.version <= upTo)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return [];

  const record = db.prepare(
    `INSERT INTO ${table} (version, name, applied_at) VALUES (?, ?, ?)`,
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
