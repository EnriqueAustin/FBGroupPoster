/**
 * Instagram campaign-DM domain model. Every part of the IG module builds
 * against these types. Nothing in here imports from store/, planner/ or
 * runner/ — and nothing here knows the Facebook module exists.
 */

export type Id = number;
export type IsoDateTime = string; // ISO-8601, always stored UTC

export type IgRunnerMode =
  | 'assisted' // Playwright follows/types, the human presses Send
  | 'auto';    // Playwright sends too

/** Where a lead was found on the source post. */
export type LeadSource = 'liker' | 'commenter';

/**
 * A lead's life. One row per Instagram username, EVER — the leads table is
 * also the "already contacted" registry, so nobody is approached twice even
 * across campaigns.
 *
 *   new ──▶ followed ──▶ messaged ──▶ replied
 *    │         │             │
 *    ▼         ▼             ▼
 *  skipped   failed      opted_out
 */
export type LeadStatus =
  | 'new'        // harvested, not yet followed
  | 'skipped'    // filtered out (reason in skipReason); never contacted
  | 'followed'   // followed; waiting for follow-back or the DM delay
  | 'messaged'   // DM sent
  | 'replied'    // they answered — the sequence stops, a human takes over
  | 'opted_out'  // "not interested" or similar; never contacted again
  | 'failed';    // gave up after repeated errors (reason in lastError)

/** Profile-level filters, applied just before following (one profile visit). */
export interface IgFilters {
  skipPrivate: boolean;
  skipBusiness: boolean;
  minFollowers: number | null;
  maxFollowers: number | null;
  /** Mass-followers (following thousands) are rarely real local customers. */
  maxFollowing: number | null;
  /** If non-empty, the bio must contain at least one of these (case-insensitive). */
  requireBioKeywords: string[];
  /** Bio containing any of these is skipped (case-insensitive). */
  excludeBioKeywords: string[];
}

export const DEFAULT_FILTERS: IgFilters = {
  skipPrivate: false,
  skipBusiness: true,
  minFollowers: null,
  maxFollowers: 5000,
  maxFollowing: 3000,
  requireBioKeywords: [],
  excludeBioKeywords: [],
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface IgCampaign {
  id: Id;
  name: string;
  /** Off = nothing is harvested, followed or messaged for it. */
  active: boolean;
  /** Source account handles, without the @. */
  sources: string[];
  /** How many of each source's newest posts to harvest. */
  postsPerSource: number;
  /** Stop collecting from one post after this many new leads. */
  maxLeadsPerPost: number;
  harvestLikers: boolean;
  harvestCommenters: boolean;
  /**
   * The DM goes out this long after the follow, whether or not they follow
   * back. A follow-back brings it forward (see IgSettings.followBackDm*).
   */
  dmDelayMinHours: number;
  dmDelayMaxHours: number;
  filters: IgFilters;
  createdAt: IsoDateTime;
}

/**
 * One phrasing of the campaign's message. Rotation across variants is the
 * main defence against "same text to N strangers" spam detection.
 *
 * Placeholders: {first_name}, {username}. A missing first name renders as
 * nothing and the surrounding punctuation is tidied ("Hi {first_name}," →
 * "Hi,"), so a variant never goes out with a hole in it.
 */
export interface IgMessageVariant {
  id: Id;
  campaignId: Id;
  text: string;
  /** Optional image sent after the text, relative to data/media. */
  imagePath: string | null;
  weight: number;
  active: boolean;
  createdAt: IsoDateTime;
}

export interface IgLead {
  id: Id;
  /** Lower-cased, no @. Globally unique. */
  username: string;
  displayName: string | null;
  campaignId: Id;
  sourceHandle: string;
  sourcePostUrl: string | null;
  source: LeadSource;
  status: LeadStatus;
  skipReason: string | null;
  harvestedAt: IsoDateTime;
  followedAt: IsoDateTime | null;
  followedBackAt: IsoDateTime | null;
  /** Earliest time the DM may go out. Set on follow, pulled forward on follow-back. */
  dmDueAt: IsoDateTime | null;
  messagedAt: IsoDateTime | null;
  /** Which variant was sent, for rotation and for reading replies in context. */
  variantId: Id | null;
  repliedAt: IsoDateTime | null;
  attempts: number;
  lastError: string | null;
}

export type IgActionKind =
  | 'harvest'        // one source post scanned
  | 'profile_visit'  // a lead's profile opened to run filters
  | 'follow'
  | 'dm'
  | 'check';         // follow-back / reply check

export type IgActionOutcome =
  | 'ok'
  | 'skipped' // decided not to act (filter); Instagram saw only a page view
  | 'failed'  // tried and could not confirm it worked
  | 'blocked'; // Instagram pushed back — trips the breaker

/** Append-only. The daily caps are counted from here. */
export interface IgAction {
  id: Id;
  kind: IgActionKind;
  outcome: IgActionOutcome;
  leadId: Id | null;
  campaignId: Id | null;
  at: IsoDateTime;
  detail: string | null;
}

export interface IgSettings {
  /** Follows per local day, all campaigns. Counts every attempt that reached Instagram. */
  dailyFollowCap: number;
  /** DMs per local day, all campaigns. */
  dailyDmCap: number;
  /** Profile visits per local day (filters + follows). Viewing is cheap, not free. */
  dailyProfileVisitCap: number;
  /** Random gap between consecutive actions. */
  minGapMinutes: number;
  maxGapMinutes: number;
  activeHourStart: number;
  activeHourEnd: number;
  timezone: string;
  /** After a follow-back is seen, the DM goes out this long after it. */
  followBackDmMinMinutes: number;
  followBackDmMaxMinutes: number;
  /** A lead that fails this many times is marked failed and left alone. */
  maxAttempts: number;
  mode: IgRunnerMode;
  /** Sticky: any block/challenge stops all IG activity until a human clears it. */
  breakerTripped: boolean;
  breakerReason: string | null;
  breakerTrippedAt: IsoDateTime | null;
}

/**
 * Conservative on purpose — this runs on the main business account, so the
 * downside of a block is the account people already know you by. Raise slowly,
 * a few at a time per week, and only while nothing has pushed back.
 */
export const DEFAULT_IG_SETTINGS: IgSettings = {
  dailyFollowCap: 25,
  dailyDmCap: 12,
  dailyProfileVisitCap: 80,
  minGapMinutes: 3,
  maxGapMinutes: 9,
  activeHourStart: 9,
  activeHourEnd: 20,
  timezone: 'Africa/Johannesburg',
  followBackDmMinMinutes: 30,
  followBackDmMaxMinutes: 180,
  maxAttempts: 3,
  mode: 'assisted',
  breakerTripped: false,
  breakerReason: null,
  breakerTrippedAt: null,
};
