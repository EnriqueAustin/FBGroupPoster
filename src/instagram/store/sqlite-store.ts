/**
 * SQLite implementation of IgStore.
 *
 * Opens its own connection to the shared database file (WAL makes two
 * connections on one file safe) and only ever touches `ig_*` tables. Column
 * names are snake_case in SQL and camelCase in the domain; that mapping
 * happens here and nowhere else.
 */
import Database from 'better-sqlite3';
import type { IgStore, LeadPatch, NewIgAction, NewIgCampaign, NewIgVariant } from '../domain/contracts.ts';
import type {
  IgAction, IgActionKind, IgActionOutcome, IgCampaign, IgFilters, IgLead, IgMessageVariant,
  IgSettings, LeadSource, LeadStatus,
} from '../domain/types.ts';
import { DEFAULT_FILTERS, DEFAULT_IG_SETTINGS } from '../domain/types.ts';
import { migrateIg } from './migrate.ts';

type Row = Record<string, unknown>;

const bool = (v: unknown): boolean => v === 1 || v === true;
const num = (v: unknown): number => Number(v);
const nul = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (v as T));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};
const b = (v: unknown) => (v ? 1 : 0);
const j = (v: unknown) => JSON.stringify(v);

/** Instagram usernames are case-insensitive; store them one way. */
export const normalizeUsername = (u: string): string => u.trim().replace(/^@/, '').toLowerCase();

export const LEAD_STATUSES: readonly LeadStatus[] =
  ['new', 'skipped', 'followed', 'messaged', 'replied', 'opted_out', 'failed'];

// --- row -> domain -----------------------------------------------------------

const toCampaign = (r: Row): IgCampaign => ({
  id: num(r.id),
  name: String(r.name),
  active: bool(r.active),
  sources: json<string[]>(r.sources, []),
  postsPerSource: num(r.posts_per_source),
  maxLeadsPerPost: num(r.max_leads_per_post),
  harvestLikers: bool(r.harvest_likers),
  harvestCommenters: bool(r.harvest_commenters),
  dmDelayMinHours: num(r.dm_delay_min_hours),
  dmDelayMaxHours: num(r.dm_delay_max_hours),
  // Merged over the defaults so a filter added later has a value on old rows.
  filters: { ...DEFAULT_FILTERS, ...json<Partial<IgFilters>>(r.filters, {}) },
  createdAt: String(r.created_at),
});

const toVariant = (r: Row): IgMessageVariant => ({
  id: num(r.id),
  campaignId: num(r.campaign_id),
  text: String(r.text),
  imagePath: nul<string>(r.image_path),
  weight: num(r.weight),
  active: bool(r.active),
  createdAt: String(r.created_at),
});

const toLead = (r: Row): IgLead => ({
  id: num(r.id),
  username: String(r.username),
  displayName: nul<string>(r.display_name),
  campaignId: num(r.campaign_id),
  sourceHandle: String(r.source_handle),
  sourcePostUrl: nul<string>(r.source_post_url),
  source: String(r.source) as LeadSource,
  status: String(r.status) as LeadStatus,
  skipReason: nul<string>(r.skip_reason),
  harvestedAt: String(r.harvested_at),
  followedAt: nul<string>(r.followed_at),
  followedBackAt: nul<string>(r.followed_back_at),
  dmDueAt: nul<string>(r.dm_due_at),
  messagedAt: nul<string>(r.messaged_at),
  variantId: numOrNull(r.variant_id),
  repliedAt: nul<string>(r.replied_at),
  attempts: num(r.attempts),
  lastError: nul<string>(r.last_error),
});

const toAction = (r: Row): IgAction => ({
  id: num(r.id),
  kind: String(r.kind) as IgActionKind,
  outcome: String(r.outcome) as IgActionOutcome,
  leadId: numOrNull(r.lead_id),
  campaignId: numOrNull(r.campaign_id),
  at: String(r.at),
  detail: nul<string>(r.detail),
});

/** `UPDATE … SET` from a camelCase patch; keys absent from the patch are untouched. */
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

export function openIgStore(dbPath: string): IgStore {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  // Another connection (the FB store) may be writing; wait rather than fail.
  db.pragma('busy_timeout = 5000');
  migrateIg(db);

  const now = () => new Date().toISOString();
  const one = (sql: string) => db.prepare(sql);

  // --- campaigns -------------------------------------------------------------
  const campaignCols = {
    name: 'name', active: 'active', sources: 'sources', postsPerSource: 'posts_per_source',
    maxLeadsPerPost: 'max_leads_per_post', harvestLikers: 'harvest_likers',
    harvestCommenters: 'harvest_commenters', dmDelayMinHours: 'dm_delay_min_hours',
    dmDelayMaxHours: 'dm_delay_max_hours', filters: 'filters',
  };
  const campaignEnc = {
    active: b, harvestLikers: b, harvestCommenters: b,
    sources: (v: unknown) => j((v as string[]).map(normalizeUsername)),
    filters: j,
  };

  const campaigns: IgStore['campaigns'] = {
    list(opts) {
      const sql = opts?.activeOnly
        ? 'SELECT * FROM ig_campaigns WHERE active = 1 ORDER BY name'
        : 'SELECT * FROM ig_campaigns ORDER BY name';
      return (one(sql).all() as Row[]).map(toCampaign);
    },
    get(id) {
      const r = one('SELECT * FROM ig_campaigns WHERE id = ?').get(id) as Row | undefined;
      return r ? toCampaign(r) : null;
    },
    create(x: NewIgCampaign) {
      const info = one(`INSERT INTO ig_campaigns
        (name, active, sources, posts_per_source, max_leads_per_post, harvest_likers,
         harvest_commenters, dm_delay_min_hours, dm_delay_max_hours, filters, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        x.name, b(x.active), campaignEnc.sources(x.sources), x.postsPerSource, x.maxLeadsPerPost,
        b(x.harvestLikers), b(x.harvestCommenters), x.dmDelayMinHours, x.dmDelayMaxHours,
        j(x.filters), now(),
      );
      return campaigns.get(Number(info.lastInsertRowid))!;
    },
    update(id, patch) {
      const { clause, vals } = buildSet(patch, campaignCols, campaignEnc);
      if (clause) one(`UPDATE ig_campaigns SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = campaigns.get(id);
      if (!found) throw new Error(`campaign ${id} not found`);
      return found;
    },
    remove(id) {
      const n = num((one('SELECT COUNT(*) AS n FROM ig_leads WHERE campaign_id = ?').get(id) as Row).n);
      if (n > 0) {
        throw new Error(`campaign ${id} has ${n} lead(s) — deactivate it instead; `
          + 'its leads are the record of who has already been contacted');
      }
      one('DELETE FROM ig_campaigns WHERE id = ?').run(id);
    },
  };

  // --- variants --------------------------------------------------------------
  const variantCols = { campaignId: 'campaign_id', text: 'text', imagePath: 'image_path', weight: 'weight', active: 'active' };

  const variants: IgStore['variants'] = {
    list(opts) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts?.campaignId !== undefined) { where.push('campaign_id = ?'); params.push(opts.campaignId); }
      if (opts?.activeOnly) where.push('active = 1');
      const sql = `SELECT * FROM ig_message_variants${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
      return (db.prepare(sql).all(...params) as Row[]).map(toVariant);
    },
    get(id) {
      const r = one('SELECT * FROM ig_message_variants WHERE id = ?').get(id) as Row | undefined;
      return r ? toVariant(r) : null;
    },
    create(x: NewIgVariant) {
      const info = one(`INSERT INTO ig_message_variants
        (campaign_id, text, image_path, weight, active, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        x.campaignId, x.text, x.imagePath, x.weight, b(x.active), now(),
      );
      return variants.get(Number(info.lastInsertRowid))!;
    },
    update(id, patch) {
      const { clause, vals } = buildSet(patch, variantCols, { active: b });
      if (clause) one(`UPDATE ig_message_variants SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = variants.get(id);
      if (!found) throw new Error(`variant ${id} not found`);
      return found;
    },
    remove(id) {
      one('DELETE FROM ig_message_variants WHERE id = ?').run(id);
    },
  };

  // --- leads -----------------------------------------------------------------
  const leadCols = {
    displayName: 'display_name', status: 'status', skipReason: 'skip_reason',
    followedAt: 'followed_at', followedBackAt: 'followed_back_at', dmDueAt: 'dm_due_at',
    messagedAt: 'messaged_at', variantId: 'variant_id', repliedAt: 'replied_at',
    attempts: 'attempts', lastError: 'last_error',
  };

  const insertLead = one(`INSERT INTO ig_leads
    (username, display_name, campaign_id, source_handle, source_post_url, source, status, harvested_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?)
    ON CONFLICT (username) DO NOTHING`);

  const leads: IgStore['leads'] = {
    list(opts) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts?.campaignId !== undefined) { where.push('campaign_id = ?'); params.push(opts.campaignId); }
      if (opts?.status !== undefined) {
        const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
      let sql = `SELECT * FROM ig_leads${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY harvested_at, id`;
      if (opts?.limit !== undefined) { sql += ' LIMIT ?'; params.push(opts.limit); }
      return (db.prepare(sql).all(...params) as Row[]).map(toLead);
    },
    get(id) {
      const r = one('SELECT * FROM ig_leads WHERE id = ?').get(id) as Row | undefined;
      return r ? toLead(r) : null;
    },
    getByUsername(username) {
      const r = one('SELECT * FROM ig_leads WHERE username = ?').get(normalizeUsername(username)) as Row | undefined;
      return r ? toLead(r) : null;
    },
    addHarvested(campaignId, people, at) {
      const added: IgLead[] = [];
      let duplicates = 0;
      db.transaction(() => {
        for (const p of people) {
          const username = normalizeUsername(p.username);
          if (!username) continue;
          const info = insertLead.run(
            username, p.displayName, campaignId, normalizeUsername(p.sourceHandle),
            p.sourcePostUrl, p.source, at,
          );
          if (info.changes === 0) duplicates++;
          else added.push(leads.get(Number(info.lastInsertRowid))!);
        }
      })();
      return { added, duplicates };
    },
    update(id, patch: LeadPatch) {
      const { clause, vals } = buildSet(patch, leadCols);
      if (clause) one(`UPDATE ig_leads SET ${clause} WHERE id = ?`).run(...vals, id);
      const found = leads.get(id);
      if (!found) throw new Error(`lead ${id} not found`);
      return found;
    },
    countByStatus(campaignId) {
      const rows = (campaignId === undefined
        ? one('SELECT status, COUNT(*) AS n FROM ig_leads GROUP BY status').all()
        : one('SELECT status, COUNT(*) AS n FROM ig_leads WHERE campaign_id = ? GROUP BY status').all(campaignId)
      ) as Row[];
      const out = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
      for (const r of rows) out[String(r.status) as LeadStatus] = num(r.n);
      return out;
    },
    hasUsername(username) {
      return one('SELECT 1 FROM ig_leads WHERE username = ?').get(normalizeUsername(username)) !== undefined;
    },
  };

  // --- actions ---------------------------------------------------------------
  const actions: IgStore['actions'] = {
    record(x: NewIgAction) {
      const info = one(`INSERT INTO ig_actions (kind, outcome, lead_id, campaign_id, at, detail)
        VALUES (?, ?, ?, ?, ?, ?)`).run(x.kind, x.outcome, x.leadId, x.campaignId, x.at, x.detail);
      return toAction(one('SELECT * FROM ig_actions WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
    },
    list(opts) {
      const params: unknown[] = [];
      let sql = 'SELECT * FROM ig_actions';
      if (opts?.leadId !== undefined) { sql += ' WHERE lead_id = ?'; params.push(opts.leadId); }
      sql += ' ORDER BY at DESC, id DESC LIMIT ?';
      params.push(opts?.limit ?? 200);
      return (db.prepare(sql).all(...params) as Row[]).map(toAction);
    },
    countBetween(kind, from, to) {
      const r = one(`SELECT COUNT(*) AS n FROM ig_actions
        WHERE kind = ? AND outcome IN ('ok', 'failed', 'blocked') AND at >= ? AND at < ?`).get(kind, from, to) as Row;
      return num(r.n);
    },
    lastDmVariantId() {
      const r = one(`SELECT variant_id FROM ig_leads
        WHERE messaged_at IS NOT NULL AND variant_id IS NOT NULL
        ORDER BY messaged_at DESC, id DESC LIMIT 1`).get() as Row | undefined;
      return r ? numOrNull(r.variant_id) : null;
    },
  };

  // --- settings --------------------------------------------------------------
  // Only values someone actually changed are stored; everything else comes
  // from DEFAULT_IG_SETTINGS at read time, so a better default shipped later
  // reaches every setting nobody has touched.
  const storedOverrides = (): Partial<IgSettings> =>
    json<Partial<IgSettings>>((one('SELECT data FROM ig_settings WHERE id = 1').get() as Row).data, {});
  const readSettings = (): IgSettings => ({ ...DEFAULT_IG_SETTINGS, ...storedOverrides() });
  const patchSettings = (patch: Partial<IgSettings>): IgSettings => {
    one('UPDATE ig_settings SET data = ? WHERE id = 1').run(j({ ...storedOverrides(), ...patch }));
    return readSettings();
  };

  const settings: IgStore['settings'] = {
    get: readSettings,
    update: patchSettings,
    tripBreaker: (reason, at) => patchSettings({ breakerTripped: true, breakerReason: reason, breakerTrippedAt: at }),
    clearBreaker: () => patchSettings({ breakerTripped: false, breakerReason: null, breakerTrippedAt: null }),
  };

  return {
    campaigns, variants, leads, actions, settings,
    close: () => db.close(),
  };
}
