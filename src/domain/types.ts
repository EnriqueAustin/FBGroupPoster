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
  createdAt: IsoDateTime;
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
  /** Facebook actively pushed back: block, checkpoint, captcha, rate limit. Trips the breaker. */
  | 'blocked';

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
