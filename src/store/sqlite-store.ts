/**
 * SQLite implementation of the Store interface.
 *
 * Synchronous by design: better-sqlite3 is synchronous, the workload is a
 * single local user, and a sync store keeps the scheduler pure and trivially
 * testable. Column names are snake_case in SQL and camelCase in the domain;
 * that mapping happens here and nowhere else.
 */
import Database from 'better-sqlite3';
import type {
  NewAd, NewAdVariant, NewBusiness, NewGroup, NewPostLog, NewQueueItem, Store,
} from '../domain/contracts.ts';
import type {
  Ad, AdVariant, Business, ComposerType, Group, GroupAssignment,
  IsoDateTime, PostLog, QueueItem, QueueStatus, Settings,
} from '../domain/types.ts';
import { DEFAULT_SETTINGS } from '../domain/types.ts';
import { migrate } from './migrate.ts';

type Row = Record<string, unknown>;

const bool = (v: unknown): boolean => v === 1 || v === true;
const num = (v: unknown): number => Number(v);
const nul = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (v as T));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

// --- row -> domain -----------------------------------------------------------

const toBusiness = (r: Row): Business => ({
  id: num(r.id),
  name: String(r.name),
  active: bool(r.active),
  dailyCapShare: numOrNull(r.daily_cap_share),
  createdAt: String(r.created_at),
});

const toGroup = (r: Row): Group => ({
  id: num(r.id),
  fbGroupId: String(r.fb_group_id),
  name: String(r.name),
  url: String(r.url),
  memberCount: numOrNull(r.member_count),
  composerType: String(r.composer_type) as ComposerType,
  active: bool(r.active),
  cooldownDaysOverride: numOrNull(r.cooldown_days_override),
  rulesNotes: String(r.rules_notes ?? ''),
  quarantinedUntil: nul<string>(r.quarantined_until),
  quarantineReason: nul<string>(r.quarantine_reason),
  tags: json<string[]>(r.tags, []),
  createdAt: String(r.created_at),
});

const toAd = (r: Row): Ad => ({
  id: num(r.id),
  businessId: num(r.business_id),
  name: String(r.name),
  composerType: String(r.composer_type) as ComposerType,
  active: bool(r.active),
  createdAt: String(r.created_at),
});

const toVariant = (r: Row): AdVariant => ({
  id: num(r.id),
  adId: num(r.ad_id),
  caption: String(r.caption),
  listingTitle: nul<string>(r.listing_title),
  listingPriceCents: numOrNull(r.listing_price_cents),
  listingCategory: nul<string>(r.listing_category),
  listingLocation: nul<string>(r.listing_location),
  imagePaths: json<string[]>(r.image_paths, []),
  weight: num(r.weight),
  active: bool(r.active),
  createdAt: String(r.created_at),
});

const toQueueItem = (r: Row): QueueItem => ({
  id: num(r.id),
  businessId: num(r.business_id),
  groupId: num(r.group_id),
  adId: num(r.ad_id),
  variantId: num(r.variant_id),
  scheduledFor: String(r.scheduled_for),
  status: String(r.status) as QueueStatus,
  attempts: num(r.attempts),
  runnerMode: String(r.runner_mode) as QueueItem['runnerMode'],
  roundId: nul<string>(r.round_id),
  lastError: nul<string>(r.last_error),
  createdAt: String(r.created_at),
});

const toPostLog = (r: Row): PostLog => ({
  id: num(r.id),
  queueItemId: numOrNull(r.queue_item_id),
  groupId: num(r.group_id),
  businessId: num(r.business_id),
  adId: num(r.ad_id),
  variantId: num(r.variant_id),
  outcome: String(r.outcome) as PostLog['outcome'],
  postedAt: String(r.posted_at),
  fbPostUrl: nul<string>(r.fb_post_url),
  error: nul<string>(r.error),
  detail: nul<string>(r.detail),
  roundId: nul<string>(r.round_id),
});

const toSettings = (r: Row): Settings => ({
  dailyCap: num(r.daily_cap),
  perGroupCooldownDays: num(r.per_group_cooldown_days),
  perGroupAdCooldownDays: num(r.per_group_ad_cooldown_days),
  minGapMinutes: num(r.min_gap_minutes),
  maxGapMinutes: num(r.max_gap_minutes),
  activeHourStart: num(r.active_hour_start),
  activeHourEnd: num(r.active_hour_end),
  timezone: String(r.timezone),
  defaultRunnerMode: String(r.default_runner_mode) as Settings['defaultRunnerMode'],
  roundsPerDay: num(r.rounds_per_day),
  minHoursBetweenRounds: num(r.min_hours_between_rounds),
  roundMinGapMinutes: num(r.round_min_gap_minutes),
  roundMaxGapMinutes: num(r.round_max_gap_minutes),
  roundDailyCap: numOrNull(r.round_daily_cap),
  breakerTripped: bool(r.breaker_tripped),
  breakerReason: nul<string>(r.breaker_reason),
  breakerTrippedAt: nul<string>(r.breaker_tripped_at),
});

/**
 * Build a `SET a = ?, b = ?` clause from a domain patch using a field->column
 * map. Only keys actually present in the patch are written, so a partial
 * update never clobbers a column it did not mention.
 */
function buildSet(
  patch: object,
  map: Record<string, string>,
  encode: Record<string, (v: unknown) => unknown> = {},
): { clause: string; vals: unknown[] } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(map)) {
    if (!(key in patch)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    const enc = encode[key];
    cols.push(`${col} = ?`);
    vals.push(enc ? enc(raw) : raw);
  }
  return { clause: cols.join(', '), vals };
}

const b = (v: unknown) => (v ? 1 : 0);
const j = (v: unknown) => JSON.stringify(v ?? []);

export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  // WAL is a no-op for :memory: databases, which is what the tests use.
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  // Migrating here rather than in the callers means no entry point can
  // accidentally open an un-migrated database.
  migrate(db);

  const now = () => new Date().toISOString();
  const one = (sql: string) => db.prepare(sql);

  // --- businesses ------------------------------------------------------------
  const businessCols = { name: 'name', active: 'active', dailyCapShare: 'daily_cap_share' };

  const businesses: Store['businesses'] = {
    list(opts) {
      const sql = opts?.activeOnly
        ? 'SELECT * FROM businesses WHERE active = 1 ORDER BY name'
        : 'SELECT * FROM businesses ORDER BY name';
      return (one(sql).all() as Row[]).map(toBusiness);
    },
    get(id) {
      const r = one('SELECT * FROM businesses WHERE id = ?').get(id) as Row | undefined;
      return r ? toBusiness(r) : null;
    },
    create(x: NewBusiness) {
      const info = one(
        'INSERT INTO businesses (name, active, daily_cap_share, created_at) VALUES (?, ?, ?, ?)',
      ).run(x.name, b(x.active), x.dailyCapShare, now());
      return businesses.get(Number(info.lastInsertRowid))!;
    },
    update(id, patch) {
      const { clause, vals } = buildSet(patch, businessCols, { active: b });
      if (clause) one(`UPDATE businesses SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = businesses.get(id);
      if (!found) throw new Error(`business ${id} not found`);
      return found;
    },
  };

  // --- groups ----------------------------------------------------------------
  const groupCols = {
    fbGroupId: 'fb_group_id', name: 'name', url: 'url', memberCount: 'member_count',
    composerType: 'composer_type', active: 'active', cooldownDaysOverride: 'cooldown_days_override',
    rulesNotes: 'rules_notes', quarantinedUntil: 'quarantined_until',
    quarantineReason: 'quarantine_reason', tags: 'tags',
  };
  const groupEnc = { active: b, tags: j };

  const groups: Store['groups'] = {
    list(opts) {
      const where: string[] = [];
      const params: unknown[] = [];
      // The business filter joins, so its parameter has to be bound first.
      let sql = 'SELECT g.* FROM groups g';
      if (opts?.businessId !== undefined) {
        sql += ' JOIN group_assignments ga ON ga.group_id = g.id AND ga.business_id = ?';
        params.push(opts.businessId);
      }
      if (opts?.activeOnly) where.push('g.active = 1');
      if (opts?.composerType) { where.push('g.composer_type = ?'); params.push(opts.composerType); }
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY g.name';
      return (db.prepare(sql).all(...params) as Row[]).map(toGroup);
    },
    get(id) {
      const r = one('SELECT * FROM groups WHERE id = ?').get(id) as Row | undefined;
      return r ? toGroup(r) : null;
    },
    getByFbId(fbGroupId) {
      const r = one('SELECT * FROM groups WHERE fb_group_id = ?').get(fbGroupId) as Row | undefined;
      return r ? toGroup(r) : null;
    },
    create(x: NewGroup) {
      const info = one(`INSERT INTO groups
        (fb_group_id, name, url, member_count, composer_type, active, cooldown_days_override,
         rules_notes, quarantined_until, quarantine_reason, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        x.fbGroupId, x.name, x.url, x.memberCount, x.composerType, b(x.active),
        x.cooldownDaysOverride, x.rulesNotes, x.quarantinedUntil, x.quarantineReason,
        j(x.tags), now(),
      );
      return groups.get(Number(info.lastInsertRowid))!;
    },
    upsertByFbId(x: NewGroup) {
      const existing = groups.getByFbId(x.fbGroupId);
      if (!existing) return { group: groups.create(x), created: true };
      return { group: groups.update(existing.id, x), created: false };
    },
    update(id, patch) {
      const { clause, vals } = buildSet(patch, groupCols, groupEnc);
      if (clause) one(`UPDATE groups SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = groups.get(id);
      if (!found) throw new Error(`group ${id} not found`);
      return found;
    },
    assignments(businessId) {
      return (one('SELECT group_id FROM group_assignments WHERE business_id = ?').all(businessId) as Row[])
        .map((r) => num(r.group_id));
    },
    setAssignments(businessId, groupIds) {
      const del = one('DELETE FROM group_assignments WHERE business_id = ?');
      const ins = one('INSERT OR IGNORE INTO group_assignments (group_id, business_id) VALUES (?, ?)');
      db.transaction(() => {
        del.run(businessId);
        for (const gid of groupIds) ins.run(gid, businessId);
      })();
    },
    allAssignments(): GroupAssignment[] {
      return (one('SELECT group_id, business_id FROM group_assignments').all() as Row[])
        .map((r) => ({ groupId: num(r.group_id), businessId: num(r.business_id) }));
    },
  };

  // --- ads -------------------------------------------------------------------
  const adCols = { businessId: 'business_id', name: 'name', composerType: 'composer_type', active: 'active' };
  const variantCols = {
    adId: 'ad_id', caption: 'caption', listingTitle: 'listing_title',
    listingPriceCents: 'listing_price_cents', listingCategory: 'listing_category',
    listingLocation: 'listing_location', imagePaths: 'image_paths', weight: 'weight', active: 'active',
  };

  const ads: Store['ads'] = {
    list(opts) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts?.businessId !== undefined) { where.push('business_id = ?'); params.push(opts.businessId); }
      if (opts?.activeOnly) where.push('active = 1');
      const sql = `SELECT * FROM ads${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name`;
      return (db.prepare(sql).all(...params) as Row[]).map(toAd);
    },
    get(id) {
      const r = one('SELECT * FROM ads WHERE id = ?').get(id) as Row | undefined;
      return r ? toAd(r) : null;
    },
    create(x: NewAd) {
      const info = one('INSERT INTO ads (business_id, name, composer_type, active, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(x.businessId, x.name, x.composerType, b(x.active), now());
      return ads.get(Number(info.lastInsertRowid))!;
    },
    update(id, patch) {
      const { clause, vals } = buildSet(patch, adCols, { active: b });
      if (clause) one(`UPDATE ads SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = ads.get(id);
      if (!found) throw new Error(`ad ${id} not found`);
      return found;
    },
    variants(adId, opts) {
      const sql = opts?.activeOnly
        ? 'SELECT * FROM ad_variants WHERE ad_id = ? AND active = 1 ORDER BY id'
        : 'SELECT * FROM ad_variants WHERE ad_id = ? ORDER BY id';
      return (one(sql).all(adId) as Row[]).map(toVariant);
    },
    getVariant(id) {
      const r = one('SELECT * FROM ad_variants WHERE id = ?').get(id) as Row | undefined;
      return r ? toVariant(r) : null;
    },
    createVariant(x: NewAdVariant) {
      const info = one(`INSERT INTO ad_variants
        (ad_id, caption, listing_title, listing_price_cents, listing_category,
         listing_location, image_paths, weight, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        x.adId, x.caption, x.listingTitle, x.listingPriceCents, x.listingCategory,
        x.listingLocation, j(x.imagePaths), x.weight, b(x.active), now(),
      );
      return ads.getVariant(Number(info.lastInsertRowid))!;
    },
    updateVariant(id, patch) {
      const { clause, vals } = buildSet(patch, variantCols, { active: b, imagePaths: j });
      if (clause) one(`UPDATE ad_variants SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = ads.getVariant(id);
      if (!found) throw new Error(`variant ${id} not found`);
      return found;
    },
  };

  // --- queue -----------------------------------------------------------------
  const queueCols = {
    status: 'status', attempts: 'attempts', lastError: 'last_error',
    scheduledFor: 'scheduled_for', runnerMode: 'runner_mode',
  };

  const queue: Store['queue'] = {
    list(opts) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts?.status) {
        const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
      if (opts?.from) { where.push('scheduled_for >= ?'); params.push(opts.from); }
      if (opts?.to) { where.push('scheduled_for <= ?'); params.push(opts.to); }
      const sql = `SELECT * FROM queue_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY scheduled_for`;
      return (db.prepare(sql).all(...params) as Row[]).map(toQueueItem);
    },
    get(id) {
      const r = one('SELECT * FROM queue_items WHERE id = ?').get(id) as Row | undefined;
      return r ? toQueueItem(r) : null;
    },
    nextDue(nowIso: IsoDateTime) {
      // 'running' is included so a run interrupted mid-post resumes that item
      // rather than stranding it forever in a non-terminal state.
      const r = one(`SELECT * FROM queue_items
        WHERE status IN ('pending', 'due', 'running') AND scheduled_for <= ?
        ORDER BY scheduled_for LIMIT 1`).get(nowIso) as Row | undefined;
      return r ? toQueueItem(r) : null;
    },
    createMany(items: NewQueueItem[]) {
      const ins = one(`INSERT INTO queue_items
        (business_id, group_id, ad_id, variant_id, scheduled_for, status, attempts,
         runner_mode, round_id, last_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`);
      const ids: number[] = [];
      db.transaction(() => {
        for (const it of items) {
          const info = ins.run(
            it.businessId, it.groupId, it.adId, it.variantId,
            it.scheduledFor, it.status, it.runnerMode, it.roundId ?? null, now(),
          );
          ids.push(Number(info.lastInsertRowid));
        }
      })();
      return ids.map((id) => queue.get(id)!);
    },
    update(id, patch) {
      const { clause, vals } = buildSet(patch, queueCols);
      if (clause) one(`UPDATE queue_items SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = queue.get(id);
      if (!found) throw new Error(`queue item ${id} not found`);
      return found;
    },
    clearPending() {
      return one("DELETE FROM queue_items WHERE status = 'pending'").run().changes;
    },
    /**
     * Re-stamp the runner mode on everything not yet handled.
     *
     * Without this, flipping assisted -> auto in Settings changed nothing you
     * could see: every already-queued item kept the mode it was committed
     * with, so the next run still stopped and asked. The orchestrator now
     * reads the live setting too, but the queue rows are what the UI shows,
     * and showing 'assisted' next to an auto run is its own kind of wrong.
     */
    setModeForWaiting(mode) {
      return one("UPDATE queue_items SET runner_mode = ? WHERE status IN ('pending', 'due')")
        .run(mode).changes;
    },
    clearRounds() {
      // 'cancelled' is swept alongside the unposted ones: a cancelled row from
      // a previous round is a dead plan with no value, and leaving it behind is
      // what made the queue look full of duplicates — the same group appearing
      // once cancelled and once pending, round after round.
      return one(`DELETE FROM queue_items
        WHERE status IN ('pending', 'due', 'cancelled') AND round_id IS NOT NULL`).run().changes;
    },
    remove(ids) {
      if (ids.length === 0) return 0;
      return db.prepare(`DELETE FROM queue_items WHERE id IN (${ids.map(() => '?').join(', ')})`)
        .run(...ids).changes;
    },
    removeByStatus(statuses) {
      if (statuses.length === 0) return 0;
      return db.prepare(`DELETE FROM queue_items WHERE status IN (${statuses.map(() => '?').join(', ')})`)
        .run(...statuses).changes;
    },
  };

  // --- log -------------------------------------------------------------------
  const log: Store['log'] = {
    append(x: NewPostLog) {
      const info = one(`INSERT INTO post_log
        (queue_item_id, group_id, business_id, ad_id, variant_id, outcome, posted_at,
         fb_post_url, error, detail, round_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        x.queueItemId, x.groupId, x.businessId, x.adId, x.variantId,
        x.outcome, x.postedAt, x.fbPostUrl, x.error, x.detail, x.roundId ?? null,
      );
      return toPostLog(one('SELECT * FROM post_log WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
    },
    list(opts) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts?.groupId !== undefined) { where.push('group_id = ?'); params.push(opts.groupId); }
      if (opts?.businessId !== undefined) { where.push('business_id = ?'); params.push(opts.businessId); }
      if (opts?.from) { where.push('posted_at >= ?'); params.push(opts.from); }
      if (opts?.to) { where.push('posted_at <= ?'); params.push(opts.to); }
      let sql = `SELECT * FROM post_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY posted_at DESC`;
      if (opts?.limit !== undefined) { sql += ' LIMIT ?'; params.push(opts.limit); }
      return (db.prepare(sql).all(...params) as Row[]).map(toPostLog);
    },
    // Cooldowns count only posts that actually landed. A skip or a failure put
    // nothing in front of that group's members, so it must not delay the next
    // attempt — otherwise one bad browser session silently freezes a group for
    // a week.
    lastPostToGroup(groupId) {
      const r = one(`SELECT * FROM post_log WHERE group_id = ? AND outcome = 'posted'
        ORDER BY posted_at DESC LIMIT 1`).get(groupId) as Row | undefined;
      return r ? toPostLog(r) : null;
    },
    lastPostOfAdToGroup(groupId, adId) {
      const r = one(`SELECT * FROM post_log WHERE group_id = ? AND ad_id = ? AND outcome = 'posted'
        ORDER BY posted_at DESC LIMIT 1`).get(groupId, adId) as Row | undefined;
      return r ? toPostLog(r) : null;
    },
    /**
     * How many round posts this group actually received in a window, and when
     * the last one landed. Round posting overrides the day-scale cooldowns, so
     * these two numbers are the entire guard against re-hitting a group too
     * soon or too often — see Settings.roundsPerDay / minHoursBetweenRounds.
     */
    roundHistoryForGroup(groupId, from, to) {
      const r = one(`SELECT COUNT(*) AS n, MAX(posted_at) AS last FROM post_log
        WHERE group_id = ? AND outcome = 'posted' AND round_id IS NOT NULL
          AND posted_at >= ? AND posted_at < ?`).get(groupId, from, to) as Row;
      return { count: num(r.n), lastPostedAt: nul<string>(r.last) };
    },
    countRoundPostsBetween(from, to) {
      const r = one(`SELECT COUNT(*) AS n FROM post_log
        WHERE outcome = 'posted' AND round_id IS NOT NULL
          AND posted_at >= ? AND posted_at < ?`).get(from, to) as Row;
      return num(r.n);
    },
    remove(ids) {
      if (ids.length === 0) return 0;
      return db.prepare(`DELETE FROM post_log WHERE id IN (${ids.map(() => '?').join(', ')})`)
        .run(...ids).changes;
    },
    removeByOutcome(outcomes) {
      if (outcomes.length === 0) return 0;
      return db.prepare(`DELETE FROM post_log WHERE outcome IN (${outcomes.map(() => '?').join(', ')})`)
        .run(...outcomes).changes;
    },
    countPostedBetween(from, to) {
      // Half-open [from, to) so consecutive day windows never double-count.
      const r = one(`SELECT COUNT(*) AS n FROM post_log
        WHERE outcome = 'posted' AND posted_at >= ? AND posted_at < ?`).get(from, to) as Row;
      return num(r.n);
    },
  };

  // --- settings --------------------------------------------------------------
  const settingsCols = {
    dailyCap: 'daily_cap', perGroupCooldownDays: 'per_group_cooldown_days',
    perGroupAdCooldownDays: 'per_group_ad_cooldown_days', minGapMinutes: 'min_gap_minutes',
    maxGapMinutes: 'max_gap_minutes', activeHourStart: 'active_hour_start',
    activeHourEnd: 'active_hour_end', timezone: 'timezone',
    defaultRunnerMode: 'default_runner_mode',
    roundsPerDay: 'rounds_per_day', minHoursBetweenRounds: 'min_hours_between_rounds',
    roundMinGapMinutes: 'round_min_gap_minutes', roundMaxGapMinutes: 'round_max_gap_minutes',
    roundDailyCap: 'round_daily_cap', breakerTripped: 'breaker_tripped',
    breakerReason: 'breaker_reason', breakerTrippedAt: 'breaker_tripped_at',
  };

  const settings: Store['settings'] = {
    get() {
      const r = one('SELECT * FROM settings WHERE id = 1').get() as Row | undefined;
      if (r) return toSettings(r);
      const d = DEFAULT_SETTINGS;
      one(`INSERT INTO settings
        (id, daily_cap, per_group_cooldown_days, per_group_ad_cooldown_days, min_gap_minutes,
         max_gap_minutes, active_hour_start, active_hour_end, timezone, default_runner_mode,
         breaker_tripped, breaker_reason, breaker_tripped_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`).run(
        d.dailyCap, d.perGroupCooldownDays, d.perGroupAdCooldownDays, d.minGapMinutes,
        d.maxGapMinutes, d.activeHourStart, d.activeHourEnd, d.timezone, d.defaultRunnerMode,
      );
      return toSettings(one('SELECT * FROM settings WHERE id = 1').get() as Row);
    },
    update(patch) {
      settings.get(); // make sure the singleton row exists before UPDATE
      const { clause, vals } = buildSet(patch, settingsCols, { breakerTripped: b });
      if (clause) one(`UPDATE settings SET ${clause} WHERE id = 1`).run(...vals);
      return settings.get();
    },
  };

  return { businesses, groups, ads, queue, log, settings, close: () => db.close() };
}
