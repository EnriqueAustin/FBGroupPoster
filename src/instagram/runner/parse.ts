/**
 * Reading Instagram's text, with no browser in sight.
 *
 * Everything the runner needs to interpret — follower counts, profile hrefs,
 * post shortcodes, whether a profile looks private or professional — is parsed
 * here from plain strings. The browser files gather raw text and hand it over,
 * so every judgement in this module is unit-testable and none of it has to be
 * re-derived by reading selectors.
 */
import type { ProfileFacts } from '../planner/filters.ts';
import { IG_ORIGIN } from './selectors.ts';

/**
 * "1,234" → 1234, "12.3K" → 12300, "1.2m" → 1200000, "" → null.
 *
 * Instagram abbreviates anything over 10,000 in the profile header and only
 * gives the exact figure in a title attribute. A null here never causes a
 * skip (see profileFilter), so an unparseable count is safe.
 */
export function parseCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d[\d.,\s]*)\s*([kmb])?/i.exec(text.trim());
  if (!m) return null;
  const suffix = m[2]?.toLowerCase();
  // Strip thousands separators. With a k/m/b suffix the separator is a decimal
  // point ("1.2k"); without one it is a grouping mark ("1,234" / "1 234").
  const digits = suffix ? m[1]!.replace(/[,\s]/g, '') : m[1]!.replace(/[.,\s]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const scale = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1;
  return Math.round(n * scale);
}

/** Usernames are lower-cased everywhere: the leads table is keyed on them. */
export function normaliseHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
}

/** Instagram's own rules: letters, digits, dots and underscores, up to 30. */
export function isPlausibleHandle(handle: string): boolean {
  return /^[a-z0-9._]{1,30}$/.test(handle) && !handle.startsWith('.') && !handle.endsWith('.');
}

/**
 * Paths that look like a profile link but are not a person: Instagram's own
 * sections, and the surfaces that appear in the same lists as profiles.
 */
const NOT_A_PROFILE = new Set([
  'p', 'reel', 'reels', 'explore', 'direct', 'stories', 'accounts', 'about', 'legal',
  'developer', 'directory', 'challenge', 'emails', 'session', 'web', 'graphql',
  'api', 'ajax', 'your_activity', 'tv', 'igtv', 'locations', 'topics', 'lite',
]);

/**
 * The username in a profile href, or null when it is not one.
 * "/thandi.m/" → "thandi.m"; "/p/Cxyz/" → null; "/explore/tags/x/" → null.
 */
export function handleFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  let path = href;
  try {
    // Absolute and relative hrefs both appear in the same list.
    path = new URL(href, IG_ORIGIN).pathname;
  } catch {
    return null;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 1) return null; // a profile link is exactly one segment
  const handle = normaliseHandle(parts[0]!);
  if (NOT_A_PROFILE.has(handle) || !isPlausibleHandle(handle)) return null;
  return handle;
}

/**
 * The shortcode of a post or reel from its href, or null.
 * "/p/CxYz1/" → "CxYz1"; "/reel/AbC/" → "AbC".
 */
export function shortcodeFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/.exec(href);
  return m ? m[1]! : null;
}

/** Post links in document order, de-duplicated — newest first on a profile. */
export function shortcodesFromHrefs(hrefs: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const href of hrefs) {
    const code = shortcodeFromHref(href);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Profile handles from a list of hrefs, de-duplicated, in document order.
 * Used for both the likes list and the comments on a post.
 */
export function handlesFromHrefs(hrefs: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const href of hrefs) {
    const handle = handleFromHref(href);
    if (handle && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/** What the browser scrapes off a profile page, before interpretation. */
export interface RawProfile {
  /** The profile header's visible text. */
  headerText: string;
  /** Labels of the buttons in the header ("Follow", "Following", "Message"…). */
  buttonLabels: string[];
  /** Exact counts from the followers/following links' title attributes, if any. */
  followersTitle: string | null;
  followingTitle: string | null;
  /** Abbreviated counts as displayed ("12.3K followers"). */
  followersText: string | null;
  followingText: string | null;
  /** The bio block's text. */
  bioText: string;
  /** The category line a professional account shows ("Restaurant", "Shop"). */
  categoryText: string | null;
  /** Whether the page itself says the account is private. */
  saysPrivate: boolean;
}

/** Phrases Instagram uses for a private profile, lower-cased. */
const PRIVATE_PHRASES = [
  'this account is private',
  'this profile is private',
  'follow this account to see their photos',
  'already follow',
];

/**
 * Words that mean "this is a business, not a customer". Only used when the
 * category line is present — a professional account always shows one, and
 * guessing from the bio alone flagged too many real people.
 */
export function looksProfessional(raw: Pick<RawProfile, 'categoryText' | 'buttonLabels'>): boolean | null {
  if (raw.categoryText && raw.categoryText.trim().length > 0) return true;
  // A professional account is the only kind with these contact buttons.
  const contactish = raw.buttonLabels.some((l) => /^(email|call|directions|book now|contact)$/i.test(l.trim()));
  if (contactish) return true;
  return null; // could not tell — never a reason to skip
}

/** Turn a scraped profile into the facts the filters are written against. */
export function profileFactsFrom(raw: RawProfile): ProfileFacts {
  const header = raw.headerText.toLowerCase();
  const labels = raw.buttonLabels.map((l) => l.trim());

  const isFollowing = labels.some((l) => /^(following|requested)$/i.test(l));
  // "Follow back" only appears when they already follow us.
  const followsUs = labels.some((l) => /^follow back$/i.test(l))
    || /\bfollows you\b/i.test(raw.headerText);

  return {
    isPrivate: raw.saysPrivate || PRIVATE_PHRASES.some((p) => header.includes(p)),
    isBusiness: looksProfessional(raw),
    followers: parseCount(raw.followersTitle) ?? parseCount(raw.followersText),
    following: parseCount(raw.followingTitle) ?? parseCount(raw.followingText),
    bio: raw.bioText,
    alreadyFollowing: isFollowing,
    followsUs,
  };
}

/**
 * Button and status words that appear in a people-list row alongside the
 * username and the person's name. Matched whole-string, lower-cased.
 */
const ROW_NOISE = /^(follow|following|follow back|requested|remove|message|verified|suggested for you|new to instagram|follows you)$/i;

/**
 * The person's display name from one row of a people list, or null.
 *
 * A row's text is roughly "username", the full name, and whatever buttons are
 * in it, one per line — but the order varies between the likes list, the
 * followers list and search results. So: drop the username, drop the button
 * words, and take the first line that is left. Null when nothing is left,
 * which is common and harmless — the message templates render a missing first
 * name as nothing rather than leaving a hole.
 */
export function displayNameFromRow(rowText: string, handle: string): string | null {
  const lines = rowText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (normaliseHandle(line) === handle) continue;
    if (ROW_NOISE.test(line)) continue;
    // A row sometimes repeats the handle with its @.
    if (normaliseHandle(line) === normaliseHandle(handle)) continue;
    return line;
  }
  return null;
}

/** One row of a scraped people list, before interpretation. */
export interface RawPersonRow {
  href: string | null;
  text: string;
}

/**
 * Turn scraped rows into {username, displayName} pairs, de-duplicated and in
 * document order. Rows that are not profile links are dropped.
 */
export function peopleFromRows(rows: readonly RawPersonRow[]): { username: string; displayName: string | null }[] {
  const seen = new Set<string>();
  const out: { username: string; displayName: string | null }[] = [];
  for (const row of rows) {
    const username = handleFromHref(row.href);
    if (!username || seen.has(username)) continue;
    seen.add(username);
    out.push({ username, displayName: displayNameFromRow(row.text, username) });
  }
  return out;
}
