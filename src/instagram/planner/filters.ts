/**
 * Who not to contact.
 *
 * Two stages, split by cost. `prefilter` runs on a bare username at harvest
 * time and costs nothing. `profileFilter` needs the person's profile open, so
 * it runs just before following and each check is a profile visit Instagram
 * sees.
 */
import type { IgFilters } from '../domain/types.ts';

export interface PrefilterContext {
  /** Already a lead, in any campaign or status. */
  isKnown: (username: string) => boolean;
  /** The campaign's source accounts — never DM the business you harvested from. */
  sourceHandles: readonly string[];
  /** The signed-in account's own handle, when known. */
  ownHandle?: string | null;
}

/** Shop/brand-like handles: rarely a local customer, often a bot or a competitor. */
const BRANDISH = /(shop|store|boutique|official|deals|promo|market|wholesale|agency|marketing|followers|_ads?$|^ads?_)/i;

/** Returns a skip reason, or null to keep. Lower-cased usernames expected. */
export function prefilter(username: string, ctx: PrefilterContext): string | null {
  if (!/^[a-z0-9._]{1,30}$/.test(username)) return 'not a valid username';
  if (ctx.ownHandle && username === ctx.ownHandle) return 'own account';
  if (ctx.sourceHandles.includes(username)) return 'is a source account';
  if (ctx.isKnown(username)) return 'already known';
  if (BRANDISH.test(username)) return 'looks like a business or bot';
  // Long digit runs ("user83749201") are the classic throwaway pattern.
  if (/\d{6,}/.test(username)) return 'looks like a bot';
  return null;
}

/** What the runner reads off a profile page. Null = could not tell. */
export interface ProfileFacts {
  isPrivate: boolean | null;
  isBusiness: boolean | null;
  followers: number | null;
  following: number | null;
  bio: string;
  /** Already followed by us (e.g. by hand) — counts as followed, no click needed. */
  alreadyFollowing: boolean;
  /** They already follow us. */
  followsUs: boolean;
}

/**
 * Returns a skip reason, or null to go ahead and follow. A fact the runner
 * could not read (null) never causes a skip: a filter should exclude what it
 * knows is wrong, not what it failed to see.
 */
export function profileFilter(p: ProfileFacts, f: IgFilters): string | null {
  if (f.skipPrivate && p.isPrivate === true) return 'private account';
  if (f.skipBusiness && p.isBusiness === true) return 'business account';
  if (f.minFollowers !== null && p.followers !== null && p.followers < f.minFollowers) {
    return `fewer than ${f.minFollowers} followers`;
  }
  if (f.maxFollowers !== null && p.followers !== null && p.followers > f.maxFollowers) {
    return `more than ${f.maxFollowers} followers`;
  }
  if (f.maxFollowing !== null && p.following !== null && p.following > f.maxFollowing) {
    return `follows more than ${f.maxFollowing} accounts`;
  }
  const bio = p.bio.toLowerCase();
  const excluded = f.excludeBioKeywords.find((k) => k.trim() && bio.includes(k.trim().toLowerCase()));
  if (excluded) return `bio mentions "${excluded.trim()}"`;
  const required = f.requireBioKeywords.filter((k) => k.trim());
  if (required.length > 0 && !required.some((k) => bio.includes(k.trim().toLowerCase()))) {
    return 'bio has none of the required keywords';
  }
  return null;
}
