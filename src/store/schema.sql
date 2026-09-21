-- SQLite schema for the FB group poster.
--
-- Conventions (mirrors src/domain/types.ts):
--   * booleans      -> INTEGER 0/1
--   * timestamps    -> TEXT, ISO-8601 in UTC. Lexicographic order == chronological
--                      order, which is what makes the BETWEEN cooldown queries work.
--   * string arrays -> JSON TEXT ('[]' when empty)
--
-- Foreign keys are enforced (the store issues PRAGMA foreign_keys = ON per
-- connection; the pragma is not persisted in the file).

CREATE TABLE IF NOT EXISTS businesses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  daily_cap_share  REAL,                 -- NULL = share the global cap evenly
  created_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_group_id            TEXT    NOT NULL UNIQUE,
  name                   TEXT    NOT NULL,
  url                    TEXT    NOT NULL,
  member_count           INTEGER,
  composer_type          TEXT    NOT NULL CHECK (composer_type IN ('status', 'listing')),
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  cooldown_days_override INTEGER,
  rules_notes            TEXT    NOT NULL DEFAULT '',
  quarantined_until      TEXT,
  quarantine_reason      TEXT,
  tags                   TEXT    NOT NULL DEFAULT '[]',  -- JSON array of strings
  created_at             TEXT    NOT NULL
  -- name_locked (0/1) is added by migration 3 in migrate.ts. It must NOT be
  -- listed here: this file is migration 1, and the later ALTER would then fail
  -- on fresh installs with a duplicate column.
);

CREATE INDEX IF NOT EXISTS idx_groups_active ON groups (active, composer_type);

-- Many-to-many. Deleting either side drops the pairing; the row carries no
-- other state so there is nothing to preserve.
CREATE TABLE IF NOT EXISTS group_assignments (
  group_id    INTEGER NOT NULL REFERENCES groups (id)     ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, business_id)
);

CREATE INDEX IF NOT EXISTS idx_group_assignments_business ON group_assignments (business_id);

CREATE TABLE IF NOT EXISTS ads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  composer_type TEXT    NOT NULL CHECK (composer_type IN ('status', 'listing')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ads_business ON ads (business_id, active);

CREATE TABLE IF NOT EXISTS ad_variants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id               INTEGER NOT NULL REFERENCES ads (id) ON DELETE CASCADE,
  caption             TEXT    NOT NULL,
  listing_title       TEXT,
  listing_price_cents INTEGER,
  listing_category    TEXT,
  listing_location    TEXT,
  image_paths         TEXT    NOT NULL DEFAULT '[]',  -- JSON array, order significant
  weight              INTEGER NOT NULL DEFAULT 1,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ad_variants_ad ON ad_variants (ad_id, active);

CREATE TABLE IF NOT EXISTS queue_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER NOT NULL REFERENCES businesses (id)  ON DELETE CASCADE,
  group_id      INTEGER NOT NULL REFERENCES groups (id)      ON DELETE CASCADE,
  ad_id         INTEGER NOT NULL REFERENCES ads (id)         ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES ad_variants (id) ON DELETE CASCADE,
  scheduled_for TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN
                  ('pending', 'due', 'running', 'posted', 'skipped', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  runner_mode   TEXT    NOT NULL CHECK (runner_mode IN ('assisted', 'auto')),
  last_error    TEXT,
  created_at    TEXT    NOT NULL
);

-- nextDue() / list-by-status both filter on status then order by time.
CREATE INDEX IF NOT EXISTS idx_queue_status_scheduled ON queue_items (status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_queue_scheduled        ON queue_items (scheduled_for);

-- Immutable history and the source of truth for cooldowns. The queue item it
-- came from may be replanned away, hence ON DELETE SET NULL rather than CASCADE:
-- losing a plan must never lose the record that we posted.
CREATE TABLE IF NOT EXISTS post_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_item_id INTEGER REFERENCES queue_items (id) ON DELETE SET NULL,
  group_id      INTEGER NOT NULL REFERENCES groups (id)      ON DELETE CASCADE,
  business_id   INTEGER NOT NULL REFERENCES businesses (id)  ON DELETE CASCADE,
  ad_id         INTEGER NOT NULL REFERENCES ads (id)         ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES ad_variants (id) ON DELETE CASCADE,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('posted', 'skipped', 'failed', 'blocked')),
  posted_at     TEXT    NOT NULL,
  fb_post_url   TEXT,
  error         TEXT,
  detail        TEXT
);

-- The cooldown lookups run once per (group, ad) candidate on every plan, so they
-- get covering-ish indexes with posted_at last for the ORDER BY ... DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS idx_post_log_group_time    ON post_log (group_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_post_log_group_ad_time ON post_log (group_id, ad_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_post_log_outcome_time  ON post_log (outcome, posted_at);
CREATE INDEX IF NOT EXISTS idx_post_log_business_time ON post_log (business_id, posted_at);

-- Single-row table. The CHECK pins the primary key to 1 so a second row cannot
-- be inserted by accident.
CREATE TABLE IF NOT EXISTS settings (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  daily_cap                 INTEGER NOT NULL,
  per_group_cooldown_days   INTEGER NOT NULL,
  per_group_ad_cooldown_days INTEGER NOT NULL,
  min_gap_minutes           INTEGER NOT NULL,
  max_gap_minutes           INTEGER NOT NULL,
  active_hour_start         INTEGER NOT NULL,
  active_hour_end           INTEGER NOT NULL,
  timezone                  TEXT    NOT NULL,
  default_runner_mode       TEXT    NOT NULL CHECK (default_runner_mode IN ('assisted', 'auto')),
  breaker_tripped           INTEGER NOT NULL DEFAULT 0 CHECK (breaker_tripped IN (0, 1)),
  breaker_reason            TEXT,
  breaker_tripped_at        TEXT
);
