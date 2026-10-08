/**
 * Sending one lead the campaign's message.
 *
 * Assisted mode types the message into the thread and stops — the human reads
 * it and presses Enter. Auto mode sends it and then confirms the message
 * actually appears in the thread. Anything unconfirmed is a failure, never a
 * "sent": a lead wrongly marked `messaged` is a person who is never contacted
 * and never followed up, and the global contacted registry means that is
 * permanent.
 *
 * The thread is reached through the new-message flow rather than the profile's
 * "Message" button. The button is not there for every account (and not at all
 * for some private ones), while /direct/new/ takes a username and works the
 * same way every time. The profile button is kept as a fallback.
 */
import type { Locator, Page } from 'playwright';
import { detectIgBlock, type IgBlockResult } from './detect.ts';
import { beat, dismissNags, findByName, pause, typeHumanely } from './humanize.ts';
import { IG_NEW_MESSAGE, profileUrl, SELECTORS } from './selectors.ts';

export type DmOutcome =
  /** The message is in the thread. */
  | { kind: 'sent' }
  /** Typed and left for the human, who said they sent it. */
  | { kind: 'sent-by-human' }
  /** The human chose to skip this one. */
  | { kind: 'skipped'; reason: string }
  /** Could not confirm. Counts against the cap — the thread was opened. */
  | { kind: 'failed'; error: string }
  | { kind: 'blocked'; block: IgBlockResult };

export interface DmOptions {
  log?: (msg: string) => void;
  /**
   * Assisted mode. Asked once the message is typed and visible in the thread.
   * Resolve 'y'/'' = I sent it, 's' = skip, 'q' = stop the run.
   */
  confirm?: (question: string, context: Record<string, unknown>) => Promise<string>;
  /** Auto mode sends without asking. Requires `confirm` to be absent. */
  auto?: boolean;
}

/**
 * Open a thread with `username` and put `text` in it.
 *
 * `text` is already rendered (placeholders filled) by the caller — see
 * planner/messages.ts. This function does not know what a variant is.
 */
export async function sendDm(
  page: Page,
  username: string,
  text: string,
  opts: DmOptions = {},
): Promise<DmOutcome> {
  const log = opts.log ?? (() => {});

  const opened = await openThread(page, username, log);
  if (opened.kind === 'blocked') return opened;
  if (opened.kind === 'failed') return opened;

  const box = await findByName(page, 'textbox', SELECTORS.dmTextbox, 8000);
  if (!box) {
    return {
      kind: 'failed',
      error: 'thread opened but no message box was found — '
        + 'SELECTORS.dmTextbox may need updating',
    };
  }

  await typeHumanely(box, text);
  await pause(500, 1200);

  // Typing is enough to provoke a restriction on a locked-down account.
  const afterTyping = await detectIgBlock(page);
  if (afterTyping.blocked) return { kind: 'blocked', block: afterTyping };

  if (!opts.auto) {
    if (!opts.confirm) {
      return { kind: 'failed', error: 'assisted mode needs a way to ask the human (no confirm callback)' };
    }
    log('');
    log(`  READY TO SEND to @${username} — read it in the browser, then send it yourself.`);
    const answer = await opts.confirm(
      '  [Enter] = I sent it  |  s = skip this lead  |  q = stop the run: ',
      { username, profileUrl: profileUrl(username), message: text },
    );
    if (answer === 's') return { kind: 'skipped', reason: 'skipped by the human' };
    if (answer === 'q') return { kind: 'skipped', reason: 'run stopped by the human' };

    // Trust the human, but still check that acting on it did not land on a
    // block screen.
    const after = await detectIgBlock(page);
    if (after.blocked) return { kind: 'blocked', block: after };
    return { kind: 'sent-by-human' };
  }

  // --- auto mode ---
  log(`  AUTO — sending to @${username} without asking`);
  const sendButton = await findByName(page, 'button', SELECTORS.dmSendButton, 3000);
  if (sendButton) {
    await beat();
    await sendButton.click({ timeout: 8000 }).catch(() => undefined);
  } else {
    // Enter sends in a DM thread. Only used when the Send button is absent,
    // which is the usual state until the box has text in it.
    await box.press('Enter').catch(() => undefined);
  }
  await pause(1500, 3000);

  const afterSend = await detectIgBlock(page);
  if (afterSend.blocked) return { kind: 'blocked', block: afterSend };

  if (await confirmInThread(page, box, text)) return { kind: 'sent' };
  return {
    kind: 'failed',
    error: 'pressed Send but the message never appeared in the thread — treat as not sent',
  };
}

type OpenOutcome = { kind: 'opened' } | { kind: 'failed'; error: string } | { kind: 'blocked'; block: IgBlockResult };

/**
 * Get a thread with `username` on screen.
 *
 * The new-message flow first: open /direct/new/, type the username, pick the
 * matching row, confirm. Then the profile's "Message" button as a fallback.
 */
async function openThread(page: Page, username: string, log: (m: string) => void): Promise<OpenOutcome> {
  await page.goto(IG_NEW_MESSAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1200, 2400);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blocked = await detectIgBlock(page);
  if (blocked.blocked) return { kind: 'blocked', block: blocked };

  const search = await findByName(page, 'textbox', SELECTORS.dmSearchBox, 6000);
  if (search) {
    await search.click().catch(() => undefined);
    // Typed per character: the recipient search is debounced and does not
    // fire on a value set in one operation.
    await search.type(username, { delay: 60 }).catch(() => undefined);
    await pause(1400, 2600);

    // The exact handle, not the first suggestion: searching "thandi" offers
    // several people, and messaging the wrong one cannot be undone.
    const row = page.getByRole('button', { name: new RegExp(`(^|\\W)${escapeRegex(username)}(\\W|$)`, 'i') }).first();
    const option = (await row.isVisible().catch(() => false))
      ? row
      : page.locator(`[role="dialog"] :text-is("${username}")`).first();

    if (await option.isVisible().catch(() => false)) {
      await beat();
      await option.click({ timeout: 6000 }).catch(() => undefined);
      await pause(600, 1200);
      const next = await findByName(page, 'button', SELECTORS.dmNextButton, 4000);
      if (next) {
        await next.click({ timeout: 6000 }).catch(() => undefined);
        await pause(1200, 2400);
        return { kind: 'opened' };
      }
    }
    log(`    @${username}: not found in the new-message search — trying the profile`);
  }

  // Fallback: the profile's Message button.
  await page.goto(profileUrl(username), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pause(1200, 2400);
  await dismissNags(page, SELECTORS.dismissDialog);

  const blockedOnProfile = await detectIgBlock(page);
  if (blockedOnProfile.blocked) return { kind: 'blocked', block: blockedOnProfile };

  const message = await findByName(page, 'button', SELECTORS.messageButton, 6000);
  if (!message) {
    return {
      kind: 'failed',
      error: `could not open a thread with @${username} — no search result and no Message button`,
    };
  }
  await beat();
  await message.click({ timeout: 8000 }).catch(() => undefined);
  await pause(1500, 3000);
  return { kind: 'opened' };
}

/**
 * Is the message really in the thread?
 *
 * Two signals, both needed: the box is empty again (Instagram clears it on
 * send), and the text appears somewhere in the conversation. Checking only
 * the box would call a dropped message sent; checking only the text would be
 * fooled by the text still sitting in the box unsent.
 */
async function confirmInThread(page: Page, box: Locator, text: string): Promise<boolean> {
  // Compare on the first line only: Instagram renders long messages with its
  // own line wrapping, and emoji can come back re-encoded.
  const needle = (text.split(/\r?\n/)[0] ?? '').trim().slice(0, 60);
  if (!needle) return false;

  for (let i = 0; i < 4; i++) {
    const boxText = (await box.innerText().catch(() => '')).trim();
    const onPage = await page.getByText(needle, { exact: false }).count().catch(() => 0);
    if (boxText.length === 0 && onPage > 0) return true;
    await pause(800, 1600);
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
