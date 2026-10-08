/**
 * Interfaces that decouple the IG module's parts. The planner knows nothing
 * about SQLite; the runner will know nothing about the planner.
 */
import type {
  Id, IgAction, IgActionKind, IgCampaign, IgFilters, IgLead, IgMessageVariant, IgSettings,
  IsoDateTime, LeadSource, LeadStatus,
} from './types.ts';

export type NewIgCampaign = Omit<IgCampaign, 'id' | 'createdAt'>;
export type NewIgVariant = Omit<IgMessageVariant, 'id' | 'createdAt'>;
export type NewIgAction = Omit<IgAction, 'id'>;

/** What the harvester hands over for one person found on a source post. */
export interface HarvestedLead {
  username: string;
  displayName: string | null;
  source: LeadSource;
  sourceHandle: string;
  sourcePostUrl: string | null;
}

/** Fields the run loop may change on a lead as it moves through its life. */
export type LeadPatch = Partial<Pick<IgLead,
  | 'displayName' | 'status' | 'skipReason' | 'followedAt' | 'followedBackAt' | 'dmDueAt'
  | 'messagedAt' | 'variantId' | 'repliedAt' | 'attempts' | 'lastError'>>;

export interface IgStore {
  campaigns: {
    list(opts?: { activeOnly?: boolean }): IgCampaign[];
    get(id: Id): IgCampaign | null;
    create(c: NewIgCampaign): IgCampaign;
    update(id: Id, patch: Partial<NewIgCampaign>): IgCampaign;
    /** Refuses once any lead references it: leads are the contacted registry. */
    remove(id: Id): void;
  };

  variants: {
    list(opts?: { campaignId?: Id; activeOnly?: boolean }): IgMessageVariant[];
    get(id: Id): IgMessageVariant | null;
    create(v: NewIgVariant): IgMessageVariant;
    update(id: Id, patch: Partial<NewIgVariant>): IgMessageVariant;
    remove(id: Id): void;
  };

  leads: {
    list(opts?: { campaignId?: Id; status?: LeadStatus | LeadStatus[]; limit?: number }): IgLead[];
    get(id: Id): IgLead | null;
    getByUsername(username: string): IgLead | null;
    /**
     * Insert harvested people as `new` leads. Anyone already known — in ANY
     * campaign, in ANY status — is left untouched and counted as a duplicate.
     */
    addHarvested(campaignId: Id, people: HarvestedLead[], at: IsoDateTime): { added: IgLead[]; duplicates: number };
    update(id: Id, patch: LeadPatch): IgLead;
    countByStatus(campaignId?: Id): Record<LeadStatus, number>;
    /** Every username ever seen, for the harvester's cheap pre-filter. */
    hasUsername(username: string): boolean;
  };

  actions: {
    record(a: NewIgAction): IgAction;
    list(opts?: { limit?: number; leadId?: Id }): IgAction[];
    /**
     * Actions of one kind in [from, to) that reached Instagram — `ok`,
     * `failed` and `blocked`. A failed follow still clicked the button, so it
     * counts against the cap; a `skipped` one did not.
     */
    countBetween(kind: IgActionKind, from: IsoDateTime, to: IsoDateTime): number;
    /** The variant used by the most recent DM, to avoid back-to-back repeats. */
    lastDmVariantId(): Id | null;
  };

  settings: {
    get(): IgSettings;
    update(patch: Partial<IgSettings>): IgSettings;
    tripBreaker(reason: string, at: IsoDateTime): IgSettings;
    clearBreaker(): IgSettings;
  };

  close(): void;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * What one attempted action amounts to, in domain terms.
 *
 * Deliberately flattened: the run loop needs to know whether a follow stuck
 * and whether they already follow us (which pulls the DM forward), and
 * nothing else about the profile. Everything the browser layer read on the
 * way to that answer stays in the browser layer.
 *
 * `blocked` is separate from `failed` because the two mean opposite things
 * for the breaker: a failure is this lead's problem, a block is the
 * account's.
 */
export type IgFollowResult =
  | { outcome: 'followed'; followsUs: boolean }
  | { outcome: 'already-following'; followsUs: boolean }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'blocked'; reason: string };

export type IgDmResult =
  /** Confirmed in the thread (auto), or the human said they sent it. */
  | { outcome: 'sent' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'blocked'; reason: string };

/** What the harvester needs from the database without being given all of it. */
export interface IgHarvestContext {
  /** Already a lead, in any campaign or status. */
  isKnown: (username: string) => boolean;
}

export interface IgHarvestResult {
  /** People found and pre-filtered, ready for store.leads.addHarvested. */
  people: HarvestedLead[];
  /** Pre-filtered-out counts by reason, for the run log. */
  skipped: Record<string, number>;
  /** Posts actually read. */
  postsRead: number;
  /** Anything the human should know: no posts, likes hidden, and so on. */
  notes: string[];
  /** Set when Instagram pushed back; the caller trips the breaker. */
  blocked?: string;
}

export type IgFollowersResult =
  | { outcome: 'ok'; followers: Set<string> }
  | { outcome: 'failed'; error: string }
  | { outcome: 'blocked'; reason: string };

/** One inbox row, matched to a lead where that could be done unambiguously. */
export interface IgInboxEntry {
  leadId: Id | null;
  title: string;
  preview: string;
  unread: boolean;
  /** 'opt-out' means never contact again; see runner/check.ts. */
  kind: 'opt-out' | 'reply';
}

export type IgInboxResult =
  | { outcome: 'ok'; entries: IgInboxEntry[] }
  | { outcome: 'failed'; error: string }
  | { outcome: 'blocked'; reason: string };

/**
 * The browser, behind an interface.
 *
 * The run loop is written against this and tested with a fake, which is what
 * keeps the loop's rules — caps, gaps, the breaker, how a failure differs
 * from a block — testable without Instagram. The Playwright implementation is
 * in runner/playwright-ig-runner.ts.
 */
export interface IgRunner {
  /**
   * Open the browser and make sure the session is signed in. False means the
   * human never finished signing in, and nothing should be attempted.
   */
  start(): Promise<boolean>;
  follow(username: string, filters: IgFilters): Promise<IgFollowResult>;
  /** `text` is already rendered; the runner does not know what a variant is. */
  dm(username: string, text: string): Promise<IgDmResult>;
  harvest(campaign: IgCampaign, sourceHandle: string, ctx: IgHarvestContext): Promise<IgHarvestResult>;
  followers(): Promise<IgFollowersResult>;
  inbox(candidates: readonly { id: Id; username: string; displayName: string | null }[]): Promise<IgInboxResult>;
  stop(): Promise<void>;
}
