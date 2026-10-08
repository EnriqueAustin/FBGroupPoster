/**
 * Noticing what the other person did: followed back, or answered.
 *
 * Both checks are deliberately cheap. A follow-back could be found by opening
 * each followed lead's profile, but that is one profile visit per lead per
 * check, against the same daily visit cap the follows need. Reading our OWN
 * followers list is one page plus scrolling, however many leads are waiting,
 * and it is a page we are entitled to read.
 *
 * A reply matters more than a follow-back: it means a person is talking to a
 * business, and the sequence must stop so a human answers. "Not interested"
 * is stronger still — that lead is marked opted_out and is never contacted
 * again, by any campaign, ever.
 */
import type { Page } from 'playwright';
import { detectIgBlock, type IgBlockResult } from './detect.ts';
import { dismissNags, pause, scrollStep } from './humanize.ts';
import { isPlausibleHandle, normaliseHandle, peopleFromRows, type RawPersonRow } from './parse.ts';
import { IG_INBOX, IG_ORIGIN, SELECTORS } from './selectors.ts';

/** How far to scroll our own followers list before giving up on it growing. */
const MAX_SCROLLS = 60;

export type FollowBackResult =
  | { kind: 'ok'; followers: Set<string> }
  | { kind: 'blocked'; block: IgBlockResult }
  | { kind: 'failed'; error: string };

/**
 * Our own followers, lower-cased.
 *
 * The caller intersects this with the leads it is waiting on, so one read
 * answers "did any of these 40 people follow back?". Scrolls until the list
 * stops growing: a business account with thousands of followers is read in
 * full, which is slow but happens once per check rather than once per lead.
 */
export async function readOwnFollowers(
  page: Page,
  ownHandle: string,
  opts: { log?: (m: string) => void; cancelled?: () => boolean } = {},
): Promise<FollowBackResult> {
  const log = opts.log ?? (() => {});
  const handle = normaliseHandle(ownHandle);
  if (!handle) return { kind: 'failed', error: 'the signed-in account’s handle is not known' };

  await page.goto(`${IG_ORIGIN}/${handle}/followers/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1200, 2400);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { kind: 'blocked', block: blocked };

  const followers = new Set<string>();
  for (let i = 0; i < MAX_SCROLLS; i++) {
    if (opts.cancelled?.()) break;
    for (const person of peopleFromRows(await scrapeRows(page))) followers.add(person.username);
    const { grew } = await scrollStep(page, '[role="dialog"] div[style*="overflow"]');
    if (!grew) break;
  }

  if (followers.size === 0) {
    return { kind: 'failed', error: 'the followers list did not load — nothing was read' };
  }
  log(`  read ${followers.size} follower(s)`);
  return { kind: 'ok', followers };
}

/** Phrases that mean "never contact me again", lower-cased. */
const OPT_OUT_PHRASES = [
  'not interested',
  'no thanks',
  'no thank you',
  'stop messaging',
  'stop contacting',
  'do not message',
  "don't message",
  'dont message',
  'leave me alone',
  'unsubscribe',
  'remove me',
  'spam',
  'reported',
  'how did you get',
];

export type ReplyKind = 'opt-out' | 'reply';

/**
 * What a reply amounts to. Pure, so the wording list can be tested.
 *
 * Biased towards opt-out: treating an interested reply as an opt-out costs
 * one lead, while missing a real "stop messaging me" means messaging someone
 * who asked not to be — which is both the fastest way to get reported and the
 * thing direct-marketing rules actually require honouring.
 */
export function classifyReply(text: string): ReplyKind {
  const t = text.toLowerCase();
  return OPT_OUT_PHRASES.some((p) => t.includes(p)) ? 'opt-out' : 'reply';
}

export interface InboxThread {
  /**
   * The row's first line as Instagram shows it. For most threads this is the
   * person's DISPLAY NAME, not their handle — the inbox shows names and links
   * to a thread id, so there is often no username on screen at all. Matching
   * a thread to a lead is therefore the caller's job (see matchThreadToLeads).
   */
  title: string;
  /** Set only when the title really is a handle. Usually null. */
  username: string | null;
  /** The last message's preview text, as the inbox row shows it. */
  preview: string;
  /** Instagram marks a thread unread until it is opened. */
  unread: boolean;
}

export type InboxResult =
  | { kind: 'ok'; threads: InboxThread[] }
  | { kind: 'blocked'; block: IgBlockResult }
  | { kind: 'failed'; error: string };

/**
 * The DM inbox, one row per thread.
 *
 * Only the list is read — threads are not opened. Opening one marks it read
 * and would take the "unread" signal away from the human, who is the one who
 * should answer. The preview text is enough to tell an opt-out from an
 * ordinary reply.
 *
 * Message requests (where a cold DM to a stranger lands) are a separate
 * inbox. They are not read here: a lead that answers from a request folder
 * has accepted it, which moves the thread into this list.
 */
export async function readInbox(page: Page, opts: { log?: (m: string) => void } = {}): Promise<InboxResult> {
  const log = opts.log ?? (() => {});

  await page.goto(IG_INBOX, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1500, 2800);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { kind: 'blocked', block: blocked };

  const rows = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/direct/t/"]'));
    return links.map((a) => {
      const row = (a.closest('li, [role="listitem"]') ?? a) as HTMLElement;
      return {
        text: row.innerText ?? '',
        // An unread thread carries a dot Instagram renders as an svg with an
        // accessible label, or a bolded preview. The label is the steadier of
        // the two.
        unread: row.querySelector('[aria-label*="nread" i]') !== null
          || /\bunread\b/i.test(row.getAttribute('aria-label') ?? ''),
      };
    });
  }).catch(() => [] as { text: string; unread: boolean }[]);

  if (rows.length === 0) return { kind: 'failed', error: 'the inbox did not load — no threads were read' };

  const threads: InboxThread[] = [];
  for (const row of rows) {
    const lines = row.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const title = lines[0] ?? '';
    if (!title) continue;
    const asHandle = normaliseHandle(title);
    threads.push({
      title,
      username: isPlausibleHandle(asHandle) ? asHandle : null,
      preview: lines.slice(1).join(' '),
      unread: row.unread,
    });
  }

  log(`  ${threads.length} thread(s) in the inbox, ${threads.filter((t) => t.unread).length} unread`);
  return { kind: 'ok', threads };
}

/** The leads a thread could belong to, as far as this module needs to know. */
export interface ThreadCandidate {
  id: number;
  username: string;
  displayName: string | null;
}

/**
 * Which lead an inbox row belongs to, or null.
 *
 * Pure, and strict on purpose. The inbox usually shows a display name, so
 * matching has to go through it — but display names are not unique, and
 * marking the wrong lead `replied` stops a sequence that should have run
 * while leaving a real reply unanswered. So an ambiguous title (two waiting
 * leads with the same display name) matches NOTHING and is left for the
 * human, who can see the thread.
 */
export function matchThreadToLeads(
  thread: Pick<InboxThread, 'title' | 'username'>,
  candidates: readonly ThreadCandidate[],
): ThreadCandidate | null {
  if (thread.username) {
    const byHandle = candidates.filter((c) => c.username === thread.username);
    if (byHandle.length === 1) return byHandle[0]!;
    if (byHandle.length > 1) return null;
  }

  const title = thread.title.trim().toLowerCase();
  if (!title) return null;
  const byName = candidates.filter((c) => (c.displayName ?? '').trim().toLowerCase() === title);
  return byName.length === 1 ? byName[0]! : null;
}

/** One pass over the rendered rows of a people list. */
async function scrapeRows(page: Page): Promise<RawPersonRow[]> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'));
    return anchors.map((a) => {
      const row = a.closest('li, [role="listitem"], [role="button"]') ?? a.parentElement ?? a;
      return { href: a.getAttribute('href'), text: (row as HTMLElement).innerText ?? '' };
    });
  }).catch(() => [] as RawPersonRow[]);
}
