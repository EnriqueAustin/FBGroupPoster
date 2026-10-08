/**
 * Every Instagram selector in the project, in one place.
 *
 * SELECTORS ARE THE FRAGILE PART OF THIS PROJECT, and Instagram's markup is
 * worse than Facebook's: class names are generated, the DOM is rebuilt between
 * releases, and the same screen differs between the logged-in web app and the
 * logged-out one. So:
 *
 * - Prefer ROLES and VISIBLE TEXT over structure. A button is found by being a
 *   button that says "Follow", not by its position in a div tree.
 * - Prefer URL SHAPES over clicking through. `/p/<shortcode>/liked_by/` is a
 *   real page; the likes modal is a render of it. Navigating is both steadier
 *   and gentler than driving a dialog.
 * - Keep several fallbacks per thing, ordered most to least specific.
 * - Text is matched case-insensitively, as a whole-string regex, so a
 *   rewording usually only needs one entry added here.
 *
 * WHEN THIS BREAKS: that is expected, not a surprise. The symptom is a run
 * that finds no likers, or cannot see a Follow button it should. Fix it here
 * and nowhere else.
 */

/** Button labels, as whole-string case-insensitive regexes. */
export const SELECTORS = {
  /** "Follow" on a profile we are not following. Excludes "Following". */
  followButton: [/^follow$/i, /^follow back$/i],
  /** State after a successful follow — or a request to a private account. */
  followingButton: [/^following$/i, /^requested$/i],
  /** Opens a DM thread with the profile in front of us. */
  messageButton: [/^message$/i, /^send message$/i],
  /** The likes list on a post page, when we have to click rather than navigate. */
  likesLink: [/^\d[\d,.\s]*(likes|like)$/i, /^(view all )?\d+ likes$/i, /^liked by/i],
  /** The DM composer. A contenteditable, not a textarea. */
  dmTextbox: [/^message$/i, /^write a message/i, /^send a message/i],
  /** Sends the typed DM in auto mode. */
  dmSendButton: [/^send$/i],
  /** New-message flow: the recipient search field and the confirm button. */
  dmSearchBox: [/^search/i, /^to:?$/i, /^recipient/i],
  dmNextButton: [/^chat$/i, /^next$/i, /^done$/i],
  /** Dismisses the "Turn on notifications" / "Add to home screen" nags. */
  dismissDialog: [/^not now$/i, /^cancel$/i, /^close$/i, /^dismiss$/i],
} as const;

export const IG_ORIGIN = 'https://www.instagram.com';
export const IG_HOME = `${IG_ORIGIN}/`;
export const IG_LOGIN = `${IG_ORIGIN}/accounts/login/`;
export const IG_NEW_MESSAGE = `${IG_ORIGIN}/direct/new/`;
export const IG_INBOX = `${IG_ORIGIN}/direct/inbox/`;

/** A profile page. `handle` must already be bare (no @). */
export function profileUrl(handle: string): string {
  return `${IG_ORIGIN}/${encodeURIComponent(handle)}/`;
}

/**
 * The list of accounts who liked a post. A real page of its own, which is why
 * harvesting navigates here instead of driving the likes dialog.
 */
export function likedByUrl(shortcode: string): string {
  return `${IG_ORIGIN}/p/${encodeURIComponent(shortcode)}/liked_by/`;
}

export function postUrl(shortcode: string): string {
  return `${IG_ORIGIN}/p/${encodeURIComponent(shortcode)}/`;
}
