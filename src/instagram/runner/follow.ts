/**
 * Visiting one lead's profile, deciding, and following.
 *
 * The profile-level filters live here rather than at harvest time because
 * each one costs a page view Instagram can see (see planner/filters.ts). So
 * this is the one place that opens a stranger's profile, and it reports the
 * visit whether or not it ends in a follow.
 *
 * Two outcomes matter and must not be confused:
 * - `skipped` — we looked and decided not to. No click reached Instagram, so
 *   it spends a profile visit and no follow.
 * - `already-following` — we were already following by hand. Also no click,
 *   but the lead moves on to the DM stage as if we had just followed.
 *
 * A follow is only ever reported after the button has been seen to change to
 * "Following" (or "Requested", for a private account). An unconfirmed click
 * is a failure: recording a follow that did not happen would schedule a cold
 * DM to someone who never saw us follow them, which is the single most
 * reportable thing this tool could do.
 */
import type { Page } from 'playwright';
import type { IgFilters } from '../domain/types.ts';
import { profileFilter, type ProfileFacts } from '../planner/filters.ts';
import { detectIgBlock, type IgBlockResult } from './detect.ts';
import { beat, dismissNags, findByName, pause } from './humanize.ts';
import { profileFactsFrom, type RawProfile } from './parse.ts';
import { profileUrl, SELECTORS } from './selectors.ts';

export type FollowOutcome =
  /** Followed, and Instagram confirmed the new state. */
  | { kind: 'followed'; facts: ProfileFacts }
  /** Already following before we got there; no click was made. */
  | { kind: 'already-following'; facts: ProfileFacts }
  /** A filter said no. Costs a profile visit only. */
  | { kind: 'skipped'; reason: string; facts: ProfileFacts }
  /** Tried and could not confirm. Counts against the cap — it clicked. */
  | { kind: 'failed'; error: string }
  /** Instagram pushed back. The caller trips the breaker and stops. */
  | { kind: 'blocked'; block: IgBlockResult };

export interface FollowOptions {
  log?: (msg: string) => void;
  /**
   * Assisted mode asks before each follow. Resolve 'y' to go ahead, 's' to
   * skip this lead, 'q' to stop the run.
   */
  confirm?: (question: string, context: Record<string, unknown>) => Promise<string>;
}

/**
 * Open `username`, run the filters, and follow if they pass.
 *
 * `filters` is the campaign's own; the caller supplies it so one run can work
 * several campaigns with different rules.
 */
export async function visitAndFollow(
  page: Page,
  username: string,
  filters: IgFilters,
  opts: FollowOptions = {},
): Promise<FollowOutcome> {
  const log = opts.log ?? (() => {});

  await page.goto(profileUrl(username), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1200, 2600);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { kind: 'blocked', block: blocked };

  const facts = profileFactsFrom(await scrapeProfile(page));

  if (facts.alreadyFollowing) {
    log(`    @${username}: already following`);
    return { kind: 'already-following', facts };
  }

  const reason = profileFilter(facts, filters);
  if (reason) {
    log(`    @${username}: skipped (${reason})`);
    return { kind: 'skipped', reason, facts };
  }

  if (opts.confirm) {
    const answer = await opts.confirm(
      `  Follow @${username}? [Enter] = yes  |  s = skip  |  q = stop the run: `,
      {
        username,
        profileUrl: profileUrl(username),
        displayName: null,
        followers: facts.followers,
        following: facts.following,
        bio: facts.bio,
        isPrivate: facts.isPrivate,
        isBusiness: facts.isBusiness,
        followsUs: facts.followsUs,
      },
    );
    if (answer === 's') return { kind: 'skipped', reason: 'skipped by the human', facts };
    if (answer === 'q') return { kind: 'failed', error: 'run stopped by the human' };
  }

  const button = await findByName(page, 'button', SELECTORS.followButton);
  if (!button) {
    return {
      kind: 'failed',
      error: 'no Follow button on the profile — the page may not have loaded, '
        + 'or SELECTORS.followButton needs updating',
    };
  }

  await beat();
  await button.click({ timeout: 10_000 }).catch(() => undefined);
  await pause(1200, 2500);

  // A block arrives as a dialog the instant the click lands, so check before
  // reading the button state: "Action Blocked" leaves the button on "Follow".
  const after = await detectIgBlock(page);
  if (after.blocked) return { kind: 'blocked', block: after };

  if (await confirmFollowing(page)) {
    log(`    @${username}: followed`);
    return { kind: 'followed', facts };
  }

  return {
    kind: 'failed',
    error: 'clicked Follow but the button never changed to Following — treat as not followed',
  };
}

/**
 * Did the button become "Following"/"Requested"?
 *
 * Polled rather than read once: the change is an optimistic UI update that
 * can be reverted a second later when the request actually fails, and the
 * reverted state is the true one.
 */
async function confirmFollowing(page: Page, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const following = await findByName(page, 'button', SELECTORS.followingButton, 2500);
    if (following) {
      await pause(700, 1400);
      // Still there after a beat? Then it stuck.
      if (await following.isVisible().catch(() => false)) return true;
    }
    await pause(600, 1200);
  }
  return false;
}

/**
 * Scrape the profile header. Everything read here is interpreted by
 * profileFactsFrom in parse.ts, so this function stays free of judgement.
 *
 * The follower counts are taken from the links' `title` attributes where
 * Instagram provides them, because the visible text is abbreviated above
 * 10,000 and a filter on "more than 5,000 followers" needs the real figure.
 */
async function scrapeProfile(page: Page): Promise<RawProfile> {
  return page.evaluate(() => {
    const text = (el: Element | null | undefined): string => (el as HTMLElement | null)?.innerText ?? '';
    const header = document.querySelector('header') ?? document.querySelector('main') ?? document.body;

    const countLink = (suffix: string): HTMLAnchorElement | null =>
      document.querySelector<HTMLAnchorElement>(`header a[href$="/${suffix}/"], main a[href$="/${suffix}/"]`);
    const followersLink = countLink('followers');
    const followingLink = countLink('following');
    // The exact number lives on the title of the link or of a span inside it.
    const titleOf = (a: HTMLAnchorElement | null): string | null =>
      a?.getAttribute('title') ?? a?.querySelector('[title]')?.getAttribute('title') ?? null;

    const buttons = Array.from(document.querySelectorAll<HTMLElement>(
      'header button, main button, header [role="button"], main [role="button"]',
    ));

    const headerText = text(header);

    return {
      headerText,
      buttonLabels: buttons.map((b) => (b.innerText ?? '').trim()).filter(Boolean),
      followersTitle: titleOf(followersLink),
      followingTitle: titleOf(followingLink),
      followersText: text(followersLink) || null,
      followingText: text(followingLink) || null,
      bioText: text(document.querySelector('header section')) || headerText,
      // Deliberately not scraped. The category line a professional account
      // shows has no stable marker — it is an unlabelled div among several —
      // and every structural guess tried so far also matched the bio of an
      // ordinary person, which with skipBusiness on would skip everybody. So
      // being a business is inferred from the contact buttons only (see
      // looksProfessional), and "unknown" is left as unknown. The field stays
      // because a reliable selector would plug straight in here.
      categoryText: null,
      saysPrivate: /this account is private|this profile is private/i.test(headerText),
    };
  }).catch(() => ({
    // A profile that would not load at all: every fact unknown, which the
    // filters treat as "do not skip on this". The follow itself will then
    // fail on the missing button, which is the correct outcome.
    headerText: '',
    buttonLabels: [],
    followersTitle: null,
    followingTitle: null,
    followersText: null,
    followingText: null,
    bioText: '',
    categoryText: null,
    saysPrivate: false,
  }));
}
