/**
 * Instagram's tables. Versioned in their own `ig_schema_version` table so the
 * IG module can evolve without touching Facebook's migration history.
 *
 * Never edit a migration that has shipped; append a new one.
 */
import type { Database } from 'better-sqlite3';
import { latestVersion, runMigrations, type Migration } from '../../core/migrations.ts';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'ig-base',
    up(db) {
      db.exec(`
        CREATE TABLE ig_campaigns (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          name                TEXT NOT NULL,
          active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          sources             TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
          posts_per_source    INTEGER NOT NULL DEFAULT 1,
          max_leads_per_post  INTEGER NOT NULL DEFAULT 50,
          harvest_likers      INTEGER NOT NULL DEFAULT 1 CHECK (harvest_likers IN (0, 1)),
          harvest_commenters  INTEGER NOT NULL DEFAULT 1 CHECK (harvest_commenters IN (0, 1)),
          dm_delay_min_hours  INTEGER NOT NULL DEFAULT 24,
          dm_delay_max_hours  INTEGER NOT NULL DEFAULT 48,
          filters             TEXT NOT NULL DEFAULT '{}',   -- JSON IgFilters
          created_at          TEXT NOT NULL
        );

        CREATE TABLE ig_message_variants (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id  INTEGER NOT NULL REFERENCES ig_campaigns(id) ON DELETE CASCADE,
          text         TEXT NOT NULL,
          image_path   TEXT,
          weight       INTEGER NOT NULL DEFAULT 1,
          active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at   TEXT NOT NULL
        );

        -- One row per username, ever: this table is also the contacted registry.
        -- campaign_id is RESTRICT: deleting a campaign must not make its leads
        -- contactable again.
        CREATE TABLE ig_leads (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          username         TEXT NOT NULL UNIQUE,
          display_name     TEXT,
          campaign_id      INTEGER NOT NULL REFERENCES ig_campaigns(id) ON DELETE RESTRICT,
          source_handle    TEXT NOT NULL,
          source_post_url  TEXT,
          source           TEXT NOT NULL CHECK (source IN ('liker', 'commenter')),
          status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN
                             ('new','skipped','followed','messaged','replied','opted_out','failed')),
          skip_reason      TEXT,
          harvested_at     TEXT NOT NULL,
          followed_at      TEXT,
          followed_back_at TEXT,
          dm_due_at        TEXT,
          messaged_at      TEXT,
          variant_id       INTEGER REFERENCES ig_message_variants(id) ON DELETE SET NULL,
          replied_at       TEXT,
          attempts         INTEGER NOT NULL DEFAULT 0,
          last_error       TEXT
        );
        CREATE INDEX idx_ig_leads_status ON ig_leads (status, dm_due_at);
        CREATE INDEX idx_ig_leads_campaign ON ig_leads (campaign_id, status);

        CREATE TABLE ig_actions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT NOT NULL CHECK (kind IN ('harvest','profile_visit','follow','dm','check')),
          outcome      TEXT NOT NULL CHECK (outcome IN ('ok','skipped','failed','blocked')),
          lead_id      INTEGER REFERENCES ig_leads(id) ON DELETE SET NULL,
          campaign_id  INTEGER REFERENCES ig_campaigns(id) ON DELETE SET NULL,
          at           TEXT NOT NULL,
          detail       TEXT
        );
        CREATE INDEX idx_ig_actions_kind_at ON ig_actions (kind, at);

        -- Single row, stored as JSON merged over DEFAULT_IG_SETTINGS on read,
        -- so adding a setting later needs no migration.
        CREATE TABLE ig_settings (
          id    INTEGER PRIMARY KEY CHECK (id = 1),
          data  TEXT NOT NULL DEFAULT '{}'
        );
        INSERT INTO ig_settings (id, data) VALUES (1, '{}');
      `);
    },
  },
];

const VERSION_TABLE = 'ig_schema_version';

export const LATEST_IG_SCHEMA_VERSION: number = latestVersion(MIGRATIONS);

export function migrateIg(db: Database): number[] {
  return runMigrations(db, VERSION_TABLE, MIGRATIONS);
}
