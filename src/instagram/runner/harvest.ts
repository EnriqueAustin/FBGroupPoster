/**
 * Collecting leads from a source account's posts. COLLECT ONLY.
 *
 * Nothing here follows anybody or sends anything. It opens a local business's
 * profile, opens its newest post(s), and writes down who engaged with them.
 * That makes it the safe half of the module and the right thing to run first
 * against the live site: if the selectors have rotted, you find out while the
 * worst possible outcome is an empty list.
 *
 * Likers first, commenters as a fallback — and as a supplement when the
 * campaign asks for both. Instagram hides or truncates like lists on some
 * posts (and on all of them for some accounts), so a harvest that only knew
 * how to read likes would silently return nothing. Commenters are arguably
 * the better lead anyway: they typed something.
 *
 * Every person is pre-filtered here (see planner/filters.ts) so that an
 * obvious non-lead never reaches the database at all.
 */
import type { Page } from 'playwright';
import type { HarvestedLead } from '../domain/contracts.ts';
import type { IgCampaign, LeadSource } from '../domain/types.ts';
import { prefilter, type PrefilterContext } from '../planner/filters.ts';
import { detectIgBlock, type IgBlockResult } from './detect.ts';
import { beat, dismissNags, pause, scrollStep } from './humanize.ts';
import { peopleFromRows, shortcodesFromHrefs, type RawPersonRow } from './parse.ts';
import { likedByUrl, postUrl, profileUrl, SELECTORS } from './selectors.ts';

export interface HarvestOptions {
  log?: (msg: string) => void;
  /** Stops a run that the human asked to stop, between page loads. */
  cancelled?: () => boolean;
}

export interface HarvestedPost {
  shortcode: string;
  url: string;
  /** People found, already pre-filtered. */
  people: HarvestedLead[];
  /** Pre-filtered-out counts, by reason, for the run log. */
  skipped: Record<string, number>;
  /** Set when the likes list could not be read and commenters were used. */
  likesUnavailable: boolean;
}

export interface HarvestReport {
  sourceHandle: string;
  posts: HarvestedPost[];
  /** Instagram pushed back; the caller must trip the breaker and stop. */
  block?: IgBlockResult;
  /** Why this source yielded nothing, when it did. */
  note?: string;
}

/** How far to scroll a likes list before giving up on it growing. */
const MAX_SCROLLS = 40;

/**
 * Harvest one source account.
 *
 * Returns what it found rather than writing it: the caller owns the database
 * and the de-duplication against it (store.leads.addHarvested), so this stays
 * a pure read of the live site.
 */
export async function harvestSource(
  page: Page,
  campaign: IgCampaign,
  sourceHandle: string,
  ctx: PrefilterContext,
  opts: HarvestOptions = {},
): Promise<HarvestReport> {
  const log = opts.log ?? (() => {});
  const posts: HarvestedPost[] = [];

  log(`  [${sourceHandle}] opening profile`);
  await page.goto(profileUrl(sourceHandle), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1200, 2500);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { sourceHandle, posts, block: blocked };

  const shortcodes = await newestPostShortcodes(page, campaign.postsPerSource);
  if (shortcodes.length === 0) {
    return {
      sourceHandle,
      posts,
      note: 'no posts found — the account may be private, renamed, or the post grid did not load',
    };
  }
  log(`  [${sourceHandle}] ${shortcodes.length} post(s): ${shortcodes.join(', ')}`);

  for (const shortcode of shortcodes) {
    if (opts.cancelled?.()) {
      return { sourceHandle, posts, note: 'stopped by the human' };
    }
    const post = await harvestPost(page, campaign, sourceHandle, shortcode, ctx, opts);
    if ('block' in post) return { sourceHandle, posts, block: post.block };
    posts.push(post.post);
  }

  return { sourceHandle, posts };
}

/** The newest `count` post links on the profile in front of us. */
async function newestPostShortcodes(page: Page, count: number): Promise<string[]> {
  // The grid is lazy, but the newest posts are the first rendered, so there is
  // no need to scroll for the handful a campaign asks for.
  const hrefs = await page.evaluate(() => Array.from(
    document.querySelectorAll<HTMLAnchorElement>('main a[href*="/p/"], main a[href*="/reel/"], article a[href]'),
  ).map((a) => a.getAttribute('href'))).catch(() => [] as (string | null)[]);
  return shortcodesFromHrefs(hrefs).slice(0, Math.max(1, count));
}

type PostOutcome = { post: HarvestedPost } | { block: IgBlockResult };

async function harvestPost(
  page: Page,
  campaign: IgCampaign,
  sourceHandle: string,
  shortcode: string,
  ctx: PrefilterContext,
  opts: HarvestOptions,
): Promise<PostOutcome> {
  const log = opts.log ?? (() => {});
  const skipped: Record<string, number> = {};
  const people: HarvestedLead[] = [];
  const seen = new Set<string>();
  let likesUnavailable = false;

  const take = (rows: { username: string; displayName: string | null }[], source: LeadSource): void => {
    for (const person of rows) {
      if (people.length >= campaign.maxLeadsPerPost) return;
      if (seen.has(person.username)) continue;
      seen.add(person.username);
      const reason = prefilter(person.username, ctx);
      if (reason) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        continue;
      }
      people.push({
        username: person.username,
        displayName: person.displayName,
        source,
        sourceHandle,
        sourcePostUrl: postUrl(shortcode),
      });
    }
  };

  if (campaign.harvestLikers) {
    const likes = await readLikers(page, shortcode, campaign.maxLeadsPerPost, opts);
    if ('block' in likes) return { block: likes.block };
    if (likes.unavailable) {
      likesUnavailable = true;
      log(`    likes list unavailable for ${shortcode} — falling back to commenters`);
    }
    take(likes.people, 'liker');
  }

  // Commenters when asked for, and always when the likes list let us down.
  const wantComments = campaign.harvestCommenters || (likesUnavailable && people.length === 0);
  if (wantComments && people.length < campaign.maxLeadsPerPost) {
    const comments = await readCommenters(page, shortcode, campaign.maxLeadsPerPost, opts);
    if ('block' in comments) return { block: comments.block };
    take(comments.people, 'commenter');
  }

  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  log(`    ${shortcode}: ${people.length} lead(s), ${skippedTotal} filtered out`);

  return { post: { shortcode, url: postUrl(shortcode), people, skipped, likesUnavailable } };
}

type PeopleOutcome =
  | { people: { username: string; displayName: string | null }[]; unavailable: boolean }
  | { block: IgBlockResult };

/**
 * Who liked the post.
 *
 * Navigates to `/p/<shortcode>/liked_by/`, which is a page rather than the
 * modal the post view opens — steadier to read, and one page load instead of
 * a click into a dialog. An empty list there is reported as `unavailable`
 * rather than "nobody liked it": Instagram hides like counts and lists on
 * plenty of posts, and the caller needs to know the difference so it can fall
 * back to commenters.
 */
async function readLikers(
  page: Page,
  shortcode: string,
  limit: number,
  opts: HarvestOptions,
): Promise<PeopleOutcome> {
  await page.goto(likedByUrl(shortcode), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1000, 2000);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { block: blocked };

  const people = await collectPeople(page, limit, opts);
  return { people, unavailable: people.length === 0 };
}

/**
 * Who commented on the post. Comments are paginated behind a "load more"
 * control that is just another button; scrolling the comment list is enough
 * for the first screensful, which is all a campaign needs.
 */
async function readCommenters(
  page: Page,
  shortcode: string,
  limit: number,
  opts: HarvestOptions,
): Promise<PeopleOutcome> {
  await page.goto(postUrl(shortcode), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1000, 2000);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { block: blocked };

  const people = await collectPeople(page, limit, opts);
  return { people, unavailable: false };
}

/**
 * Read every profile link on the page, scrolling until the list stops growing
 * or we have enough. Instagram's people lists are virtualised, so rows are
 * collected as they appear rather than in one pass at the end.
 */
async function collectPeople(
  page: Page,
  limit: number,
  opts: HarvestOptions,
): Promise<{ username: string; displayName: string | null }[]> {
  const byUsername = new Map<string, { username: string; displayName: string | null }>();

  for (let i = 0; i < MAX_SCROLLS; i++) {
    if (opts.cancelled?.()) break;

    for (const person of peopleFromRows(await scrapeRows(page))) {
      if (!byUsername.has(person.username)) byUsername.set(person.username, person);
    }
    // Over-collect: the caller pre-filters, and roughly half of a likes list
    // is usually filtered out, so stopping at exactly `limit` rows tends to
    // yield far fewer than `limit` leads.
    if (byUsername.size >= limit * 3) break;

    const { grew } = await scrollStep(page, '[role="dialog"] div[style*="overflow"]');
    if (!grew) break;
  }

  return [...byUsername.values()];
}

/**
 * One pass over the rendered rows.
 *
 * A "row" is the nearest list item or link container, so the person's name
 * comes along with the href. Reading the whole document rather than a scoped
 * container is deliberate: the likes page, the followers dialog and the
 * comment list each nest their rows differently, and the pre-filter plus
 * handleFromHref throw away anything that is not a person.
 */
async function scrapeRows(page: Page): Promise<RawPersonRow[]> {
  await beat();
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'));
    return anchors.map((a) => {
      const row = a.closest('li, [role="listitem"], [role="button"]') ?? a.parentElement ?? a;
      return {
        href: a.getAttribute('href'),
        text: (row as HTMLElement).innerText ?? a.innerText ?? '',
      };
    });
  }).catch(() => [] as RawPersonRow[]);
}
