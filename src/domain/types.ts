/**
 * Core domain model. Every module builds against these types.
 * Nothing in here imports from store/, scheduler/, runner/ or server/.
 */

export type Id = number;
export type IsoDateTime = string; // ISO-8601, always stored UTC

/** How a post has to be composed inside the group. */
export type ComposerType =
  | 'status'   // normal group composer: caption + image(s)
  | 'listing'; // marketplace-style "Sell something": title, price, category, location, description

export type RunnerMode =
  | 'assisted' // Playwright fills everything, human clicks Post
  | 'auto';    // Playwright clicks Post too

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Business {
  id: Id;
  name: string;
  active: boolean;
  /** Optional per-business share of the global daily cap. Null = share evenly. */
  dailyCapShare: number | null;
  /**
   * Who this business posts as. Null = the personal profile, which is what
   * every business did before identities existed, so an upgrade changes
   * nothing until a Page is chosen.
   */
  identityId: Id | null;
  createdAt: IsoDateTime;
}

/**
 * Who a post goes out as.
 *
 * There is exactly one 'profile' — the account signed in to the browser
 * profile. 'page' identities are Facebook Pages that account manages; the
 * runner switches the same session into the Page (Facebook's own profile
 * switcher) before posting, so no second login is involved.
 *
 * This is not multi-account rotation: every identity is the same signed-in
 * person, used openly, and they share one circuit breaker and one set of
 * per-group cooldowns.
 */
export type IdentityKind = 'profile' | 'page';

export interface Identity {
  id: Id;
  name: string;
  kind: IdentityKind;
  /** The Page's address, e.g. https://www.facebook.com/yourpage. Null for the profile. */
  pageUrl: string | null;
  /**
   * The id Facebook uses for the Page while acting as it (the `i_user`
   * cookie). Learned on the first successful switch, then used to verify
   * every later one. Null for the profile, and for a Page never switched into.
   */
  fbPageId: string | null;
  createdAt: IsoDateTime;
}

/**
 * "This identity is a member of this group." Groups are shared across
 * identities (one row per Facebook group), but membership is not: a Page has
 * to join each group itself, and many groups do not allow Pages at all.
 */
export interface GroupMembership {
  groupId: Id;
  identityId: Id;
  /** False once an import for this identity no longer finds the group. */
  active: boolean;
  /** When an import last saw this identity in the group. */
  lastSeenAt: IsoDateTime | null;
  /**
   * Set when the group refused a post from THIS identity — typically a group
   * that does not allow Pages. Kept off the group itself so a Page being
   * refused never stops the personal profile posting there.
   */
  quarantinedUntil: IsoDateTime | null;
  quarantineReason: string | null;
}

export interface Group {
  id: Id;
  /** Facebook's own group id, parsed from the URL. Unique. */
  fbGroupId: string;
  name: string;
  url: string;
  memberCount: number | null;
  composerType: ComposerType;
  /** Off = never scheduled, but history is kept. */
  active: boolean;
  /** Per-group override of the global cooldown, in days. */
  cooldownDaysOverride: number | null;
  /** Free text: admin rules, "no links", "Tuesdays only", etc. Shown before every post. */
  rulesNotes: string;
  /** Set when a post fails or the group rejects us; excluded until cleared. */
  quarantinedUntil: IsoDateTime | null;
  quarantineReason: string | null;
  tags: string[];
  /**
   * True once a human has typed this group's name: any groups.update whose
   * patch carries `name` sets it. The importer never overwrites a locked name,
   * so re-running the import cannot wipe hand edits. Only an explicit
   * `nameLocked: false` patch clears it, handing the name back to the importer.
   */
  nameLocked: boolean;
  createdAt: IsoDateTime;
}

/** Many-to-many: which businesses may post into which groups. */
export interface GroupAssignment {
  groupId: Id;
  businessId: Id;
}

export interface Ad {
  id: Id;
  businessId: Id;
  name: string;
  composerType: ComposerType;
  active: boolean;
  createdAt: IsoDateTime;
}

/**
 * A concrete phrasing of an ad. Rotation across variants is the main defence
 * against "identical text posted to N groups" pattern detection.
 */
export interface AdVariant {
  id: Id;
  adId: Id;
  /** status composer: the post body. listing composer: the description. */
  caption: string;
  /** listing composer only. */
  listingTitle: string | null;
  listingPriceCents: number | null;
  listingCategory: string | null;
  listingLocation: string | null;
  /** Absolute paths under data/media. Order matters. */
  imagePaths: string[];
  /** Higher = picked more often. Default 1. */
  weight: number;
  active: boolean;
  createdAt: IsoDateTime;
}

export type QueueStatus =
  | 'pending'   // planned, not yet due
  | 'due'       // scheduled time reached, awaiting the runner
  | 'running'   // runner has it open
  | 'posted'
  | 'skipped'   // human skipped it, or a precondition failed
  | 'failed'    // runner error, retryable
  | 'cancelled';

export interface QueueItem {
  id: Id;
  businessId: Id;
  groupId: Id;
  adId: Id;
  variantId: Id;
  scheduledFor: IsoDateTime;
  status: QueueStatus;
  attempts: number;
  runnerMode: RunnerMode;
  /**
   * Set when this item came from a round (campaign posting) rather than the
   * drip planner. Items sharing a roundId were planned together and are paced
   * by the round gap settings instead of the normal ones.
   */
  roundId: string | null;
  lastError: string | null;
  createdAt: IsoDateTime;
}

export type PostOutcome =
  | 'posted'
  | 'skipped'
  | 'failed'
  /**
   * Facebook actively pushed back. The runner reports this for EVERY kind of
   * pushback; the orchestrator decides from PostResult.blockKind whether it is
   * account-wide (trips the breaker) or confined to one group (does not).
   */
  | 'blocked';

/**
 * What kind of pushback a page showed. Lives in the domain rather than in
 * src/runner/detect.ts because it crosses the Runner contract: the
 * orchestrator needs it to decide between "stop everything" and "skip this
 * group", and PostResult (a domain contract) has to be able to carry it.
 *
 * 'pending-approval' is not a block at all — it means the post DID go out and
 * is waiting for a group admin. It is recognised here so that it can be told
 * apart from the real group-level refusals it used to be lumped in with.
 */
export type BlockKind =
  | 'temporary-block'
  | 'checkpoint'
  | 'captcha'
  | 'rate-limit'
  | 'login-required'
  | 'group-restricted'
  | 'pending-approval';

/** Immutable history. This is the source of truth for cooldowns. */
export interface PostLog {
  id: Id;
  queueItemId: Id | null;
  groupId: Id;
  businessId: Id;
  adId: Id;
  variantId: Id;
  outcome: PostOutcome;
  postedAt: IsoDateTime;
  fbPostUrl: string | null;
  error: string | null;
  /** Runner-specific diagnostic detail, screenshots path, etc. */
  detail: string | null;
  /**
   * The round this post belonged to, or null for a normal drip post. Round
   * pacing (roundsPerDay, minHoursBetweenRounds) counts rows carrying this,
   * so it has to survive into the log rather than living only on the queue.
   */
  roundId: string | null;
  /** Who it went out as. Null on rows written before identities existed. */
  identityId: Id | null;
}

export interface Settings {
  /** Hard ceiling on posts per calendar day across ALL businesses. */
  dailyCap: number;
  /** Minimum days before the same group may receive any post again. */
  perGroupCooldownDays: number;
  /** Minimum days before the same group receives the same ad again. */
  perGroupAdCooldownDays: number;
  /** Randomised gap between consecutive posts. */
  minGapMinutes: number;
  maxGapMinutes: number;
  /** Local active window, 0-23. Nothing is scheduled outside it. */
  activeHourStart: number;
  activeHourEnd: number;
  /** IANA zone used for "calendar day" and active hours. */
  timezone: string;
  defaultRunnerMode: RunnerMode;

  // --- round (campaign) posting ---------------------------------------------
  // A "round" is one pass of a single ad through every group selected for its
  // business, rotating variants. It exists for the case the drip planner
  // deliberately refuses: the same ad, into the same groups, several times a
  // day. The per-group day cooldowns do not apply inside a round — these
  // settings are what replaces them, and they are the only thing between you
  // and a posting block. Raise them slowly.

  /** Maximum rounds any one group may receive per calendar day. */
  roundsPerDay: number;
  /** Minimum hours between two rounds reaching the SAME group. */
  minHoursBetweenRounds: number;
  /** Randomised gap between consecutive posts inside one round. */
  roundMinGapMinutes: number;
  roundMaxGapMinutes: number;
  /**
   * Ceiling on round posts per calendar day, kept separate from `dailyCap` so
   * round posting cannot silently consume the drip planner's budget.
   * Null = no extra ceiling beyond roundsPerDay per group.
   */
  roundDailyCap: number | null;
  /** When tripped, the runner refuses to post until a human clears it. */
  breakerTripped: boolean;
  breakerReason: string | null;
  breakerTrippedAt: IsoDateTime | null;
}

export const DEFAULT_SETTINGS: Settings = {
  dailyCap: 15,
  perGroupCooldownDays: 7,
  perGroupAdCooldownDays: 21,
  minGapMinutes: 18,
  maxGapMinutes: 55,
  activeHourStart: 8,
  activeHourEnd: 21,
  timezone: 'Africa/Johannesburg',
  defaultRunnerMode: 'assisted',
  roundsPerDay: 2,
  minHoursBetweenRounds: 3,
  roundMinGapMinutes: 5,
  roundMaxGapMinutes: 12,
  roundDailyCap: null,
  breakerTripped: false,
  breakerReason: null,
  breakerTrippedAt: null,
};
