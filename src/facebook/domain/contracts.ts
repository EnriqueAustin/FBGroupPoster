/**
 * Interfaces that decouple the modules. The scheduler knows nothing about
 * SQLite; the runner knows nothing about the scheduler; the server knows
 * nothing about Playwright.
 */
import type {
  Ad, AdVariant, BlockKind, Business, ComposerType, Group, GroupAssignment,
  GroupMembership, Id, Identity, IsoDateTime, PostLog, PostOutcome, QueueItem, QueueStatus,
  RunnerMode, Settings,
} from './types.ts';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// nameLocked is optional on input: nearly every create is a scraped group,
// which starts unlocked, and on update the store derives the lock itself
// (see groups.update) — so callers only mention it to unlock deliberately.
export type NewGroup = Omit<Group, 'id' | 'createdAt' | 'nameLocked'> & { nameLocked?: boolean };
// identityId is optional on input: null (the personal profile) is the default
// and what every business was before identities existed.
export type NewBusiness = Omit<Business, 'id' | 'createdAt' | 'identityId'> & { identityId?: Id | null };
export type NewAd = Omit<Ad, 'id' | 'createdAt'>;
export type NewAdVariant = Omit<AdVariant, 'id' | 'createdAt'>;
export type NewQueueItem = Omit<QueueItem, 'id' | 'createdAt' | 'attempts' | 'lastError'>;
export type NewPostLog = Omit<PostLog, 'id' | 'identityId'> & { identityId?: Id | null };
export type NewIdentity = Pick<Identity, 'name' | 'pageUrl'>;

/**
 * Who a new group row is a member as. Omitted = the personal profile: the
 * registry held only the profile's groups before identities existed, and
 * every caller that does not know about identities still means that.
 */
export interface GroupCreateOptions {
  memberOf?: Id[];
}

export interface Store {
  businesses: {
    list(opts?: { activeOnly?: boolean }): Business[];
    get(id: Id): Business | null;
    create(b: NewBusiness): Business;
    update(id: Id, patch: Partial<NewBusiness>): Business;
  };

  identities: {
    list(): Identity[];
    get(id: Id): Identity | null;
    /** The personal profile. Always exists (seeded by migration). */
    profile(): Identity;
    /** Who a business posts as: its identity, or the profile when unset. */
    forBusiness(business: Pick<Business, 'identityId'>): Identity;
    /** Pages only — the profile is seeded, never created. */
    createPage(i: NewIdentity): Identity;
    update(id: Id, patch: Partial<Pick<Identity, 'name' | 'pageUrl' | 'fbPageId'>>): Identity;
    /**
     * Remove a Page. Its memberships go with it; businesses posting as it fall
     * back to the profile; history keeps its rows (identity_id is nulled).
     * Refuses the profile.
     */
    remove(id: Id): void;
  };

  memberships: {
    list(opts?: { identityId?: Id; groupId?: Id }): GroupMembership[];
    get(groupId: Id, identityId: Id): GroupMembership | null;
    /** Upsert one membership. A new row starts active. */
    set(groupId: Id, identityId: Id,
      patch: Partial<Omit<GroupMembership, 'groupId' | 'identityId'>>): GroupMembership;
    /**
     * Make an import's findings the truth for one identity: every group in
     * `seenGroupIds` becomes an active membership stamped `at`, and every other
     * membership of that identity is deactivated. Quarantines are untouched —
     * still being in a group says nothing about whether it accepts our posts.
     */
    sync(identityId: Id, seenGroupIds: Id[], at: IsoDateTime): { added: number; deactivated: number };
    /** Lift every membership quarantine still in force. Returns how many. */
    clearQuarantines(): number;
  };

  groups: {
    /** identityId = only groups where that identity has an active membership. */
    list(opts?: { activeOnly?: boolean; businessId?: Id; composerType?: ComposerType; identityId?: Id }): Group[];
    get(id: Id): Group | null;
    getByFbId(fbGroupId: string): Group | null;
    create(g: NewGroup, opts?: GroupCreateOptions): Group;
    /**
     * Insert or update by fbGroupId. Used by the bootstrap importer, so unlike
     * update() it does NOT lock the name it writes: a scraped name is not a
     * human edit. The existing lock is kept unless `nameLocked` is given.
     * `opts.memberOf` applies only when the row is created; on update the
     * caller manages memberships itself (see memberships.sync).
     */
    upsertByFbId(g: NewGroup, opts?: GroupCreateOptions): { group: Group; created: boolean };
    /**
     * Partial update. A patch that carries `name` also sets nameLocked = true
     * (every caller of this is a human edit via the Groups tab), unless the
     * patch states `nameLocked` explicitly — that is how a name is unlocked.
     */
    update(id: Id, patch: Partial<NewGroup>): Group;
    assignments(businessId: Id): Id[];
    setAssignments(businessId: Id, groupIds: Id[]): void;
    allAssignments(): GroupAssignment[];
  };

  ads: {
    list(opts?: { businessId?: Id; activeOnly?: boolean }): Ad[];
    get(id: Id): Ad | null;
    create(a: NewAd): Ad;
    update(id: Id, patch: Partial<NewAd>): Ad;
    variants(adId: Id, opts?: { activeOnly?: boolean }): AdVariant[];
    getVariant(id: Id): AdVariant | null;
    createVariant(v: NewAdVariant): AdVariant;
    updateVariant(id: Id, patch: Partial<NewAdVariant>): AdVariant;
  };

  queue: {
    list(opts?: { status?: QueueStatus | QueueStatus[]; from?: IsoDateTime; to?: IsoDateTime }): QueueItem[];
    get(id: Id): QueueItem | null;
    /**
     * Earliest item that is due and not yet terminal. `businessIds` limits it
     * to those businesses — how a run sticks to its own identity's posts while
     * another identity's run works through theirs.
     */
    nextDue(now: IsoDateTime, opts?: { businessIds?: Id[] }): QueueItem | null;
    createMany(items: NewQueueItem[]): QueueItem[];
    update(id: Id, patch: Partial<Pick<QueueItem, 'status' | 'attempts' | 'lastError' | 'scheduledFor' | 'runnerMode'>>): QueueItem;
    /** Drop everything still 'pending' — used when replanning. */
    clearPending(): number;
    /**
     * Re-stamp the runner mode on every item not yet handled. Changing the
     * mode in Settings has to reach items that were committed under the old
     * one, or the change appears to do nothing.
     */
    setModeForWaiting(mode: RunnerMode): number;
    /**
     * Drop unposted round items, so a new round replaces a stale one.
     * `businessIds` limits it to those businesses, so starting a round for one
     * identity does not delete a round another identity is running.
     */
    clearRounds(opts?: { businessIds?: Id[] }): number;
    /**
     * Permanently delete queue rows. Unlike cancelling, nothing is left behind.
     * Safe for history: post_log rows point at queue items with ON DELETE SET
     * NULL, so deleting a queue item never deletes the record that we posted.
     */
    remove(ids: Id[]): number;
    /** Permanently delete every queue row in these statuses. */
    removeByStatus(statuses: QueueStatus[]): number;
  };

  log: {
    append(entry: NewPostLog): PostLog;
    list(opts?: { groupId?: Id; businessId?: Id; from?: IsoDateTime; to?: IsoDateTime; limit?: number }): PostLog[];
    /** Successful posts only, for cooldown maths. */
    lastPostToGroup(groupId: Id): PostLog | null;
    lastPostOfAdToGroup(groupId: Id, adId: Id): PostLog | null;
    countPostedBetween(from: IsoDateTime, to: IsoDateTime): number;
    /** Round posts this group actually received in [from, to), and the latest. */
    roundHistoryForGroup(groupId: Id, from: IsoDateTime, to: IsoDateTime):
      { count: number; lastPostedAt: IsoDateTime | null };
    /** Round posts across all groups in [from, to). Enforces roundDailyCap. */
    countRoundPostsBetween(from: IsoDateTime, to: IsoDateTime): number;
    /** Reset all round rest periods by nullifying round_id in history. */
    resetRoundLimits(): number;
    /**
     * All-time count of rows with this outcome. A SQL COUNT, not list().length:
     * list() takes a limit, and a dashboard total computed from a capped list
     * silently stops growing once history passes the cap.
     */
    countByOutcome(outcome: PostOutcome): number;
    /** How many of these ids are rows with this outcome. Unknown ids count 0. */
    countIdsWithOutcome(ids: Id[], outcome: PostOutcome): number;
    /**
     * Permanently delete history rows.
     *
     * This is destructive in a way nothing else in the Store is: post_log is
     * what every cooldown is computed from, so deleting a 'posted' row makes
     * the planner believe that group never heard from you. Callers must say so.
     */
    remove(ids: Id[]): number;
    /** Permanently delete every history row with these outcomes. */
    removeByOutcome(outcomes: PostOutcome[]): number;
  };

  settings: {
    get(): Settings;
    update(patch: Partial<Settings>): Settings;
  };

  close(): void;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** One planned post, before it is persisted to the queue. */
export interface PlannedPost {
  businessId: Id;
  groupId: Id;
  adId: Id;
  variantId: Id;
  scheduledFor: IsoDateTime;
  /** Set only for posts belonging to a round. */
  roundId?: string;
}

/** Why a candidate group did not make the plan. Surfaced in dry-run output. */
export interface PlanExclusion {
  groupId: Id;
  businessId: Id;
  reason:
    | 'group-inactive'
    | 'group-quarantined'
    | 'cooldown'
    | 'ad-cooldown'
    | 'no-eligible-ad'
    | 'daily-cap'
    | 'outside-active-hours'
    | 'no-assignment'
    // the business posts as an identity (usually a Page) that has not joined
    // this group, or whose membership an import no longer finds
    | 'not-a-member'
    // round-only reasons; the day-scale cooldowns do not apply inside a round
    | 'rounds-today'
    | 'round-too-soon'
    | 'round-daily-cap';
  detail?: string;
}

export interface Plan {
  generatedAt: IsoDateTime;
  windowStart: IsoDateTime;
  windowEnd: IsoDateTime;
  posts: PlannedPost[];
  exclusions: PlanExclusion[];
}

export interface Scheduler {
  /**
   * Build a plan for the given window WITHOUT persisting anything.
   * Pure and deterministic given (store snapshot, now, seed) so it can be tested.
   */
  plan(opts: { now: IsoDateTime; windowEnd: IsoDateTime; seed?: number }): Plan;
  /** Build a plan and write it to the queue. Returns the created items. */
  commit(plan: Plan): QueueItem[];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Everything the runner needs; it never touches the store itself. */
export interface PostJob {
  queueItemId: Id;
  group: Group;
  ad: Ad;
  variant: AdVariant;
  mode: RunnerMode;
  /**
   * Who to post as. The runner switches the browser into this identity before
   * opening the group, and refuses to compose if it cannot confirm the switch.
   * The orchestrator always sets it; absent means "do not switch", which only
   * test doubles rely on.
   */
  identity?: Identity;
}

export interface PostResult {
  outcome: PostOutcome;
  /**
   * The Page id the runner observed while acting as job.identity, when that
   * identity had none stored yet. The orchestrator saves it so every later
   * switch can be verified against it.
   */
  learnedFbPageId?: string;
  fbPostUrl?: string;
  error?: string;
  detail?: string;
  /**
   * Set whenever outcome is 'blocked'. The orchestrator uses it to tell an
   * account-wide block (requeue + trip the breaker) from a group-level one
   * (record it, move on). A 'blocked' result WITHOUT a kind is treated as
   * account-wide — when in doubt, stop.
   */
  blockKind?: BlockKind;
}

export interface Runner {
  /** Open the browser / attach to the profile. */
  start(): Promise<void>;
  /**
   * Compose the post in the group.
   * assisted: fills everything, waits for the human to click Post (or skip).
   * auto:     clicks Post itself.
   * MUST return 'blocked' (never 'failed') on checkpoint / captcha / rate-limit
   * screens, with blockKind set, so the caller can trip the circuit breaker.
   * A post that went out but awaits admin approval is 'posted', not 'blocked'.
   */
  post(job: PostJob): Promise<PostResult>;
  stop(): Promise<void>;
}

/** Result of the one-time "what groups am I in?" import. */
export interface DiscoveredGroup {
  fbGroupId: string;
  name: string;
  url: string;
  memberCount: number | null;
  /** Best-effort guess; the human confirms it in the UI. */
  composerTypeGuess: ComposerType;
}

export interface GroupDiscoverer {
  discover(): Promise<DiscoveredGroup[]>;
}
