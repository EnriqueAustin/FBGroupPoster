/**
 * One-time import of the groups you already belong to.
 *
 * Reads your own joined-groups list in your own logged-in session. The parsing
 * helpers are pure so they can be tested without a browser; only `discover()`
 * needs Playwright.
 */
import type { DiscoveredGroup, GroupDiscoverer } from '../domain/contracts.ts';
import type { ComposerType } from '../domain/types.ts';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { FACEBOOK_GROUPS_JOINED, FACEBOOK_HOME, firstPage, isLoggedIn, launchBrowser, login } from './browser.ts';

export interface DiscoverOptions {
  projectRoot?: string;
  log?: (msg: string) => void;
  /** Give up scrolling after this many passes that reveal nothing new. */
  idleScrollLimit?: number;
  /** How long to wait for the human to sign in. Default 10 minutes. */
  loginTimeoutMs?: number;
  /**
   * Blocks until the human says they have finished signing in.
   *
   * Automatic detection is not trustworthy here: Facebook sets the session
   * cookie before two-factor completes, and its 2FA screens vary by account,
   * region and challenge type, so any list of URLs or phrases is a guess that
   * silently fails on the case it did not anticipate. The person at the
   * keyboard knows for certain — so ask them, and never close the browser
   * while waiting. Resolving to false cancels the import.
   */
  confirmSignIn?: () => Promise<boolean>;
}

/** Words that suggest a group expects marketplace-style listings. */
const LISTING_HINTS = [
  'buy', 'sell', 'sale', 'for sale', 'marketplace', 'market', 'trade', 'swap',
  'classified', 'bazaar', 'te koop', 'koop', 'verkoop',
];

export function guessComposerType(groupName: string): ComposerType {
  const n = groupName.toLowerCase();
  return LISTING_HINTS.some((h) => n.includes(h)) ? 'listing' : 'status';
}

/** Pull the group id out of any of the URL shapes Facebook uses. */
export function parseGroupId(url: string): string | null {
  const m = /\/groups\/([^/?#]+)/.exec(url);
  if (!m || !m[1]) return null;
  const id = m[1];
  // These are list/section pages, not groups.
  if (['joins', 'feed', 'discover', 'create', 'your_groups'].includes(id)) return null;
  return id;
}

/**
 * "3.2K members" / "1,234 members" / "12 300 lede" -> number.
 * Returns null when nothing parses, which is fine: member count is cosmetic.
 */
export function parseMemberCount(text: string): number | null {
  const m = /([\d.,\s]+)\s*([km])?\s*(members|member|lede|lid)/i.exec(text);
  if (!m || !m[1]) return null;
  const digits = m[1].replace(/[\s,]/g, '');
  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  const suffix = m[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(value * 1_000);
  if (suffix === 'm') return Math.round(value * 1_000_000);
  return Math.round(value);
}

/**
 * Phrases that only ever appear in notification / activity text, never in a
 * group's own name. Notification cards link to the group they are about, so
 * the scrape sees them as "a card with a /groups/ link" exactly like a real
 * group card — this list is what tells them apart.
 */
const NOTIFICATION_PHRASES = [
  'approved your', 'declined your', 'accepted your', 'commented on', 'replied to',
  'reacted to', 'posted in', 'shared a', 'shared your', 'invited you', 'mentioned you',
  'tagged you', 'requested to join', 'wants to join', 'added you', 'changed the name',
  'is live', 'went live', 'new post in', 'new posts in', 'also commented',
];

/**
 * A relative timestamp glued to the end: "…Adverts.12h", "… · 3d", "Just now",
 * "5 minutes ago". The digits must follow a non-alphanumeric character (or
 * start the string) so a real name ending in e.g. "4x4" or "Area51" survives.
 */
const TRAILING_RELATIVE_TIME =
  /(?:(?:^|[^a-z0-9])\d{1,3}\s?(?:s|m|h|d|w|y|min|mins|hr|hrs|wk|wks)|just now|yesterday|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)$/i;

/**
 * True when a scraped label is notification text rather than a group name.
 * Exported separately from cleanGroupName so re-import can recognise junk that
 * an older version of the scraper already saved to the database.
 */
export function looksLikeNotification(raw: string): boolean {
  const s = raw.replace(/\s+/g, ' ').trim();
  // Facebook renders the unread marker as its own text node with no separator,
  // so innerText glues it to the sentence: "UnreadAn admin approved…". Match
  // only that glued form (or a bare "Unread") so a group genuinely called
  // "Unread Books Club" is not thrown away.
  if (/^Unread(?:$|[A-Z])/.test(s) || /^unread$/i.test(s)) return true;
  const lower = s.toLowerCase();
  if (NOTIFICATION_PHRASES.some((p) => lower.includes(p))) return true;
  return TRAILING_RELATIVE_TIME.test(s);
}

/**
 * Turn the first line of a scraped card into a group name, or null when the
 * card was not a group card at all.
 *
 * Deliberately rejects rather than repairs: pulling "Cape Town Adverts" out of
 * "An admin approved your photo in Cape Town Adverts.12h" means parsing prose
 * whose wording varies by language and notification type, and a wrong guess
 * gets saved as the group's name. The group's real card on the joined list
 * supplies the proper name anyway, so dropping the notification loses nothing.
 * (It also keeps out groups that appear only in notifications — which may be
 * groups you are not even a member of.)
 */
export function cleanGroupName(raw: string): string | null {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (looksLikeNotification(s)) return null;
  return s;
}

/**
 * Pick the better of two names seen for the same group id.
 *
 * Longest-wins used to be the whole rule, and that is how notification text
 * ("…approved your photo in Cape Town Adverts.12h") beat the real name: junk
 * is the real name with extra words wrapped around it, so it is always longer.
 * Now: a name that is not notification-like beats one that is; and if one
 * name contains the other somewhere other than at the start, the shorter wins,
 * because that shape is "real name wrapped in chrome". Only a plain prefix
 * extension ("Group" vs "Group One Full Name") still prefers the longer name —
 * that shape is a truncated label, not added junk.
 */
export function pickGroupName(a: string, b: string): string {
  const aJunk = looksLikeNotification(a);
  const bJunk = looksLikeNotification(b);
  if (aJunk !== bJunk) return aJunk ? b : a;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const at = longer.toLowerCase().indexOf(shorter.toLowerCase());
  if (at > 0) return shorter;
  return longer;
}

/** Deduplicate by group id, keeping the entry with the most information. */
export function mergeDiscovered(rows: DiscoveredGroup[]): DiscoveredGroup[] {
  const byId = new Map<string, DiscoveredGroup>();
  for (const row of rows) {
    const existing = byId.get(row.fbGroupId);
    if (!existing) { byId.set(row.fbGroupId, row); continue; }
    const name = pickGroupName(existing.name, row.name);
    byId.set(row.fbGroupId, {
      ...existing,
      name,
      // The listing guess is derived from the name, so it follows the winner.
      composerTypeGuess: guessComposerType(name),
      memberCount: existing.memberCount ?? row.memberCount,
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createGroupDiscoverer(opts: DiscoverOptions = {}): GroupDiscoverer {
  const log = opts.log ?? ((m: string) => console.log(m));
  const idleLimit = opts.idleScrollLimit ?? 4;

  return {
    async discover(): Promise<DiscoveredGroup[]> {
      const browser = await launchBrowser({ projectRoot: opts.projectRoot, log });
      try {
        const page = await firstPage(browser.context);
        await page.goto(FACEBOOK_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        if (await isLoggedIn(page)) {
          log('[discover] existing session found — no sign-in needed.');
        } else if (opts.confirmSignIn) {
          log('Sign in to Facebook in the Chrome window, including any code or');
          log('phone approval. The browser stays open and nothing happens until');
          log('you confirm. This app never sees your password.');
          const ok = await opts.confirmSignIn();
          if (!ok) throw new Error('import cancelled before sign-in was confirmed');
        } else {
          // No confirmer available (plain CLI): fall back to detection.
          const signedIn = await login(browser.context, {
            log,
            ...(opts.loginTimeoutMs === undefined ? {} : { timeoutMs: opts.loginTimeoutMs }),
          });
          if (!signedIn) throw new Error('timed out waiting for sign-in');
        }

        // Retry the navigation a few times: a just-completed 2FA often lands on
        // an interstitial, and one more load clears it.
        let links = 0;
        for (let attempt = 1; attempt <= 3 && links === 0; attempt++) {
          log(`[discover] opening your joined-groups list (attempt ${attempt})…`);
          await page.goto(FACEBOOK_GROUPS_JOINED, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForSelector('a[href*="/groups/"]', { timeout: 30_000 }).catch(() => {});
          await page.waitForTimeout(2500);
          links = await page.locator('a[href*="/groups/"]').count().catch(() => 0);
          if (links === 0) log('[discover] nothing yet, retrying…');
        }

        // The list is virtualised, so scrape as we scroll rather than once at
        // the end — rows that scroll far enough out of view get recycled.
        const collected: DiscoveredGroup[] = [];
        let idlePasses = 0;
        let seen = 0;

        while (idlePasses < idleLimit) {
          const rows = await page.evaluate(() => {
            const out: { href: string; text: string }[] = [];
            for (const a of Array.from(document.querySelectorAll('a[href*="/groups/"]'))) {
              const anchor = a as HTMLAnchorElement;
              // Walk up for the card text so the member count comes along.
              const card = anchor.closest('[role="listitem"]') ?? anchor.parentElement ?? anchor;
              out.push({ href: anchor.href, text: (card as HTMLElement).innerText ?? anchor.innerText ?? '' });
            }
            return out;
          });

          for (const row of rows) {
            const id = parseGroupId(row.href);
            if (!id) continue;
            // Notification/activity cards link to groups too; cleanGroupName
            // drops them so their text can never become a group's name.
            const name = cleanGroupName(row.text.split('\n')[0] ?? '');
            if (!name) continue;
            collected.push({
              fbGroupId: id,
              name,
              url: `https://www.facebook.com/groups/${id}`,
              memberCount: parseMemberCount(row.text),
              composerTypeGuess: guessComposerType(name),
            });
          }

          const unique = new Set(collected.map((c) => c.fbGroupId)).size;
          idlePasses = unique > seen ? 0 : idlePasses + 1;
          seen = unique;
          log(`  ${unique} group(s) so far…`);

          // Scroll the window and the tallest scrollable container. Facebook
          // sometimes puts the group list in its own scroller, in which case
          // scrolling the window alone does nothing at all.
          await page.evaluate(() => {
            window.scrollBy(0, 1500);
            const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*'))
              .filter((n) => n.scrollHeight > n.clientHeight + 200 && n.clientHeight > 200);
            const tallest = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
            if (tallest) tallest.scrollTop += 1500;
          });
          await page.mouse.wheel(0, 1500);
          await page.waitForTimeout(1400);
        }

        const merged = mergeDiscovered(collected);

        // Zero is never a valid answer here — you ran this because you are in
        // groups. Reporting "done, 0 groups" reads like success and hides a
        // broken scrape, so fail with something actionable instead.
        if (merged.length === 0) {
          const stamp = Date.now();
          const dir = path.join('data', 'media', 'diagnostics');
          await mkdir(dir, { recursive: true }).catch(() => {});
          const shot = path.join(dir, `discover-empty-${stamp}.png`);
          await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

          // Dump what the page actually was. Without this, diagnosing a failed
          // scrape means another full round-trip through a real sign-in.
          const diag = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            anchors: Array.from(document.querySelectorAll('a[href*="/groups/"]'))
              .slice(0, 20).map((a) => (a as HTMLAnchorElement).href),
            text: (document.body?.innerText ?? '').slice(0, 600),
          })).catch(() => null);

          if (diag) {
            await writeFile(path.join(dir, `discover-empty-${stamp}.json`),
              JSON.stringify(diag, null, 2)).catch(() => {});
            log(`[discover] page was: ${diag.title} — ${diag.url}`);
            log(`[discover] group-ish links on page: ${diag.anchors.length}`);
            log(`[discover] first text: ${diag.text.slice(0, 200).replace(/\n/g, ' | ')}`);
          }

          throw new Error(
            `Found no groups. Saved a screenshot and a page dump in ${dir} (discover-empty-${stamp}.*). `
            + 'Send those over and the scraping can be fixed against what your account actually shows.',
          );
        }

        log(`Discovered ${merged.length} group(s).`);
        return merged;
      } finally {
        log('[discover] closing the browser.');
        await browser.close();
      }
    },
  };
}
