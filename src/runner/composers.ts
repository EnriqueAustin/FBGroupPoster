/**
 * Filling in Facebook's two different post composers.
 *
 * SELECTORS ARE THE FRAGILE PART OF THIS PROJECT. Facebook's markup is
 * generated and changes without notice, so everything user-visible is located
 * by accessible role or visible text rather than class names, and every lookup
 * has several fallbacks. All of it lives in SELECTORS below so there is exactly
 * one place to fix when something breaks. See README.md in this folder.
 *
 * The composers themselves never click Post. Submitting is the caller's
 * decision, because in assisted mode it is the human's; auto mode calls
 * submitPost() below.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Locator, Page } from 'playwright';
import type { AdVariant } from '../domain/types.ts';

/** Every piece of Facebook UI this module depends on, in one place. */
export const SELECTORS = {
  /**
   * The "Write something..." entry point on a group page.
   * Note `what.s` rather than `what's`: Facebook renders a typographic
   * apostrophe (’) in some locales, which a straight quote never matches.
   */
  openStatusComposer: [
    /^write something/i,
    /^what.s on your mind/i,
    /^start a discussion/i,
    /^create a public post/i,
    /^create a post/i,
    /^start a post/i,
    /^post something/i,
    /^skryf iets/i,        // Afrikaans
    /^anonymous post/i,
  ],
  /** The rich-text area inside the open composer dialog. */
  statusTextbox: ['textbox'] as const,
  /**
   * Accessible names of textboxes that are NEVER the composer: the comment and
   * reply boxes under other members' posts ("Comment as <name>", "Write a
   * comment…"). Real diagnostics show these on group pages, and one can sit
   * inside a dialog too when a post is opened in a modal. Typing an ad caption
   * into one comments on a stranger's post, so they are excluded by name even
   * inside the composer dialog. Anchored, so a composer labelled e.g.
   * "Create a public post…" can never match.
   */
  commentTextbox: [/^comment/i, /^write a comment/i, /^reply/i, /^write a reply/i],
  /** Buttons that attach media, inside the open composer. */
  addPhoto: [
    /photo\/video/i,
    /photo or video/i,
    /add photos?/i,
    /add image/i,
    /^photos?$/i,
    /foto\/video/i,      // Afrikaans
  ],
  /** The listing / "Sell something" entry point. */
  openListingComposer: [/sell something/i, /list something/i, /create new listing/i],
  listingFields: {
    title: [/^title$/i, /what are you selling/i],
    price: [/^price$/i],
    category: [/^category$/i],
    location: [/^location$/i, /^city$/i],
    description: [/^description$/i, /describe your item/i],
  },
  /**
   * Confirms a post. Clicked only in auto mode.
   *
   * Every pattern is anchored, and submitPost matches them inside the open
   * composer dialog rather than on the page, for the same reason: a group page
   * is full of the word "Post" — the Posts tab, "Post approval", other members'
   * menus. Ordered most- to least-specific; "Next" comes last because on the
   * listing composer it advances a step rather than publishing.
   */
  submit: [/^post$/i, /^publish$/i, /^share now$/i, /^post to group$/i, /^share$/i, /^next$/i],
} as const;

export interface ComposerContext {
  page: Page;
  variant: AdVariant;
  log: (msg: string) => void;
}

export class ComposerError extends Error {
  constructor(message: string, readonly hint: string) {
    super(`${message} — ${hint}`);
    this.name = 'ComposerError';
  }
}

/** Pause for a human-plausible interval. Not evasion; just not instant. */
const pause = (min: number, max: number) =>
  new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));

/**
 * Type text the way a person does: per character, with a varying rhythm and a
 * longer beat after sentence breaks. Pasting a whole caption in one operation
 * also tends to break Facebook's rich-text editor, so this is as much about
 * correctness as pacing.
 */
export async function typeHumanely(locator: Locator, text: string): Promise<void> {
  await locator.click();
  await pause(200, 600);
  // \r?\n: a caption saved from a Windows textarea arrives with CRLF, and a
  // stray '\r' would otherwise be pressed as a key of its own.
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const ch of line) {
      await locator.press(ch === ' ' ? 'Space' : ch, { delay: 20 + Math.random() * 70 })
        .catch(async () => { await locator.type(ch, { delay: 30 }); });
      if ('.!?'.includes(ch)) await pause(150, 400);
    }
    // Newlines go BETWEEN lines only. The first version pressed one after every
    // line including the last, so every caption went out with a trailing blank
    // line. Shift+Enter rather than Enter keeps a newline from submitting.
    if (i < lines.length - 1) await locator.press('Shift+Enter').catch(() => undefined);
  }
}

/** True when a textbox's accessible name marks it as a comment/reply box. */
export function isCommentTextboxName(name: string): boolean {
  const n = name.trim();
  return SELECTORS.commentTextbox.some((re) => re.test(n));
}

/**
 * What statusComposer should do given what the group page offers right now.
 * Pure so the decision can be tested without a browser.
 *
 * A buy-and-sell group shows "Sell Something" and no "Write something…", so a
 * status-type group that only ever shows the listing opener is misconfigured.
 * Without this check it burns the full opener timeout and then fails with a
 * generic "could not find the group composer" that points at SELECTORS, which
 * is the wrong fix. The grace period exists because the two openers need not
 * render in the same frame: seeing "Sell Something" first must not fail a
 * group whose "Write something…" is merely a beat behind.
 */
export function decideStatusOpener(
  statusFound: boolean,
  listingSeenForMs: number | null,
  graceMs: number,
): 'use-status' | 'wrong-composer' | 'keep-waiting' {
  if (statusFound) return 'use-status';
  if (listingSeenForMs !== null && listingSeenForMs >= graceMs) return 'wrong-composer';
  return 'keep-waiting';
}

/**
 * Facebook is a single-page app: `domcontentloaded` fires while the screen is
 * still the Meta splash logo, and content arrives seconds later. Wait for the
 * app shell to actually exist before looking for anything inside it.
 */
export async function waitForPageReady(page: Page, log: (m: string) => void = () => {}): Promise<void> {
  await page.waitForSelector('[role="main"], [role="feed"]', { timeout: 45_000 }).catch(() => {
    log('    [warn] page shell never appeared — continuing anyway');
  });
  // Settles the burst of XHR that renders the group body. Best-effort: a busy
  // page may never go fully idle, and that is fine.
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await pause(600, 1200);
}

/**
 * Every clickable thing on the page, by accessible name. Only used to build a
 * useful error: when a lookup fails, the actual wording is the one piece of
 * information needed to fix it, and guessing has repeatedly proved worthless.
 */
async function describeClickables(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll('button, [role="button"], [contenteditable="true"], [role="textbox"]');
    const seen = new Set<string>();
    for (const n of Array.from(nodes).slice(0, 400)) {
      const e = n as HTMLElement;
      if (e.offsetParent === null) continue; // not visible
      const label = (e.getAttribute('aria-label') ?? e.innerText ?? '').trim().replace(/\s+/g, ' ');
      if (label) seen.add(`${e.getAttribute('role') ?? e.tagName.toLowerCase()}: ${label.slice(0, 80)}`);
    }
    return [...seen].slice(0, 60);
  }).catch(() => []);
}

/**
 * Try each pattern, repeatedly, until one matches or time runs out.
 *
 * The polling matters as much as the patterns: the first version checked each
 * candidate once, immediately after navigation, and so reliably lost a race
 * against the SPA finishing its render.
 */
async function firstVisible(
  scope: Page | Locator,
  role: 'button' | 'textbox',
  patterns: readonly RegExp[],
  what: string,
  timeoutMs = 25_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = await findVisible(scope, role, patterns);
    if (found) return found;
    await pause(750, 750);
  }

  const clickables = await describeClickables(pageOf(scope));
  throw new ComposerError(
    `could not find ${what} after ${Math.round(timeoutMs / 1000)}s`,
    `tried ${patterns.map(String).join(', ')}. What the page actually offers:\n`
    + (clickables.length ? clickables.map((c) => `      · ${c}`).join('\n') : '      (nothing clickable found — page may not have loaded)')
    + '\n      Add the right wording to SELECTORS in src/runner/composers.ts',
  );
}

/**
 * One pass of firstVisible, no waiting. Scope is a Page or a Locator (usually
 * the composer dialog) — both expose the same getBy* API, which is the point:
 * a field looked up inside the dialog cannot match a lookalike elsewhere.
 */
async function findVisible(
  scope: Page | Locator,
  role: 'button' | 'textbox',
  patterns: readonly RegExp[],
): Promise<Locator | null> {
  for (const pattern of patterns) {
    const byRole = scope.getByRole(role, { name: pattern }).first();
    if (await byRole.isVisible().catch(() => false)) return byRole;
    const byText = scope.getByText(pattern).first();
    if (await byText.isVisible().catch(() => false)) return byText;
  }
  return null;
}

/** The Page behind a scope. A Locator has .page(); a Page does not. */
function pageOf(scope: Page | Locator): Page {
  return typeof (scope as Locator).page === 'function' ? (scope as Locator).page() : scope as Page;
}

/**
 * The composer dialog each page's current post is being written in, as the
 * token stamped on it by pinComposerDialog. Absent means no composer dialog was
 * pinned for this post — i.e. the listing form opened as a full page.
 */
const pinnedDialogs = new WeakMap<Page, string>();
const COMPOSER_ATTR = 'data-fbgp-composer';
let pinCounter = 0;

/**
 * Wait for the composer dialog that clicking an opener mounts, pin it, and
 * return a locator for exactly that element — or null if none appeared.
 *
 * This is the ONE place the composer dialog is chosen; statusComposer,
 * listingComposer, attachImages and submitPost all use the element picked
 * here. The first versions each did their own `getByRole('dialog').first()`,
 * which could pick a chat popover or cookie notice instead of the composer.
 *
 * `.last()` rather than `.first()`: a dialog opened by our click is appended
 * after anything already on the page, so the newest visible one is the
 * composer. Hidden dialogs are skipped — Facebook leaves closed ones in the DOM.
 *
 * Why pin with an attribute instead of returning that locator: Playwright
 * locators re-resolve on every use. "Newest visible dialog" re-evaluated after
 * the composer closes is some OTHER dialog (or nothing), so submitPost's
 * "dialog closed" receipt would watch the wrong element. A locator on a unique
 * attribute tracks the one element; it reads hidden once that element hides or
 * is removed. This assumes React keeps the dialog's root node while it is open,
 * which it does for a mounted modal.
 */
async function pinComposerDialog(page: Page, timeoutMs: number): Promise<Locator | null> {
  pinnedDialogs.delete(page); // a new post never inherits the last post's dialog
  const newest = page.getByRole('dialog').filter({ visible: true }).last();
  const appeared = await newest.waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true).catch(() => false);
  if (!appeared) return null;

  const token = `c${++pinCounter}`;
  const tagged = await newest.evaluate((el, [attr, value]) => {
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    el.setAttribute(attr, value);
  }, [COMPOSER_ATTR, token] as const).then(() => true).catch(() => false);
  if (!tagged) return null;

  pinnedDialogs.set(page, token);
  return dialogByToken(page, token);
}

/** The dialog pinned for this page's current post, if any (visible or not). */
function pinnedComposerDialog(page: Page): Locator | null {
  const token = pinnedDialogs.get(page);
  return token ? dialogByToken(page, token) : null;
}

function dialogByToken(page: Page, token: string): Locator {
  return page.locator(`[${COMPOSER_ATTR}="${token}"]`);
}

/**
 * The accessible name of a textbox, as far as it can be read from the DOM:
 * aria-label, then the text of aria-labelledby targets, then aria-placeholder.
 * Facebook's comment boxes carry "Comment as <name>" in one of these.
 */
async function textboxName(box: Locator): Promise<string> {
  return box.evaluate((el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label;
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = ids.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ').trim();
      if (text) return text;
    }
    return el.getAttribute('aria-placeholder') ?? el.getAttribute('placeholder') ?? '';
  }).catch(() => '');
}

/**
 * The first visible textbox inside `dialog` that is not a comment/reply box.
 * Polls, because the editor mounts a moment after the dialog frame does.
 */
async function composerTextbox(dialog: Locator, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const box of await dialog.getByRole('textbox').all().catch(() => [])) {
      if (!await box.isVisible().catch(() => false)) continue;
      if (isCommentTextboxName(await textboxName(box))) continue;
      return box;
    }
    await pause(500, 500);
  }
  return null;
}

/**
 * Attach the variant's images to the OPEN composer.
 *
 * Three things went wrong in the first version, and all three are worth
 * spelling out because each failed silently:
 *
 *  1. It searched the whole page for `input[type=file]`. A Facebook group page
 *     carries several unrelated hidden file inputs (profile photo, cover, chat
 *     attachments). `.first()` picked one of those, `setInputFiles` succeeded
 *     against it, and nothing appeared in the composer.
 *  2. Because some file input always exists somewhere on the page, the guard
 *     `count() === 0` was never true, so it never clicked "Photo/video" — the
 *     button that actually mounts the composer's own input.
 *  3. Nothing verified the result, so the post went out with no image.
 *
 * Now: scope to the composer dialog, click Photo/video to mount its input,
 * then confirm a preview appeared before letting the post proceed.
 *
 * The scope is passed in rather than looked up here. The caller has already
 * chosen the composer (pinComposerDialog) and knows whether a page-wide scope
 * is legitimate: statusComposer only ever passes its pinned dialog, because it
 * refuses to continue without one; listingComposer passes the page only when
 * the listing form opened as a full page and there is no dialog to scope to.
 * An independent lookup here once had its own guess, and could disagree.
 */
async function attachImages(
  page: Page,
  scope: Page | Locator,
  imagePaths: string[],
  log: (m: string) => void,
): Promise<void> {
  if (imagePaths.length === 0) return;

  // Playwright resolves relative paths against the process cwd, but being
  // explicit removes any doubt about where the server was started from.
  const files = imagePaths.map((p) => path.resolve(p));
  for (const f of files) {
    if (!existsSync(f)) {
      throw new ComposerError(`image file is missing: ${f}`,
        're-upload the image for this variant in the Ads tab');
    }
  }

  // Everything below must happen inside the composer, not the page at large.
  // If the pinned dialog vanished since the caption went in, stop: falling
  // back to the page here would hit the unrelated file inputs described above.
  if (scope !== page && !await (scope as Locator).isVisible().catch(() => false)) {
    throw new ComposerError('the composer dialog closed before the images were attached',
      'the post was NOT sent. Check the screenshot in data/media/diagnostics');
  }
  if (scope === page) log('    [warn] no composer dialog (full-page listing form) — attaching against the page');

  // Click Photo/video: this is what mounts the composer's own file input.
  //
  // In some layouts that click opens the file picker straight away. Unless
  // Playwright is listening for 'filechooser' at that moment, Chrome shows the
  // real Windows file explorer — and setInputFiles below fills the input behind
  // it, so the image attaches but the explorer window sits there forever.
  // Listening intercepts the picker (no native window) and hands it to us.
  let attached = false;
  for (const pattern of SELECTORS.addPhoto) {
    const btn = scope.getByRole('button', { name: pattern }).first();
    if (await btn.isVisible().catch(() => false)) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
      await btn.click().catch(() => {});
      const chooser = await chooserPromise;
      if (chooser) {
        attached = await chooser.setFiles(files).then(() => true).catch(() => false);
      }
      await pause(700, 1500);
      break;
    }
  }

  if (!attached) {
    const input = scope.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {
      throw new ComposerError('the composer has no file input',
        'check SELECTORS.addPhoto in src/runner/composers.ts — the Photo/video button may have moved');
    });
    await input.setInputFiles(files);
  }
  log(`    attaching ${files.length} image(s)…`);

  // Verify. A thumbnail preview or a "Remove photo" control means it landed.
  // Without this check the post goes out silently missing its image, which is
  // worse than not posting at all.
  const preview = scope.locator(
    'img[src^="blob:"], img[src^="data:"], [aria-label*="Remove" i], [aria-label*="photo" i] img',
  ).first();
  const ok = await preview.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);

  if (!ok) {
    throw new ComposerError('the image did not attach to the composer',
      'the post was NOT sent. Facebook may have changed the photo flow — check '
      + 'SELECTORS.addPhoto and the preview check in src/runner/composers.ts');
  }

  log(`    ${files.length} image(s) attached`);
  await pause(1500, 3000); // let the upload settle before the composer is used
}

/**
 * Click Post, and prove it actually posted. Auto mode only.
 *
 * The first version of this was one line, in the runner, against the whole
 * page — and every part of it was wrong in a way that failed silently:
 *
 *  1. It searched the page rather than the composer. A group page has a "Posts"
 *     tab and other posts' own controls, so `.first()` could pick any of them:
 *     the click did nothing visible and the run still reported success.
 *  2. It tried only SELECTORS.submit[0], ignoring the fallbacks that exist for
 *     exactly this reason.
 *  3. It never waited for the button to become ENABLED. Facebook keeps Post
 *     greyed out until the image finishes uploading, and clicking a disabled
 *     button does nothing at all.
 *  4. Nothing verified the outcome, so a post that never went out was logged as
 *     'posted' — which then feeds the cooldown maths and buries the failure.
 *
 * The confirmation is the composer closing. That is what Facebook does on a
 * successful submit, and it is the one signal that does not depend on markup.
 */
export async function submitPost(page: Page, log: (m: string) => void): Promise<void> {
  // Use the very dialog the composer pinned, so the Post button is looked for
  // in it and the "closed" receipt below watches it — not whichever dialog is
  // newest by the time Post is clicked.
  //
  // The page-wide fallback stays, but ONLY when no dialog was pinned at all,
  // which happens for one reason: the listing form opened as a full page, where
  // there is no dialog to scope to and refusing would make that layout
  // unpostable in auto mode. When a dialog WAS pinned and is now gone, that is
  // not a layout — the composer closed or re-rendered under us — so stop rather
  // than hunt for "Post" across a page full of lookalikes.
  const dialog = pinnedComposerDialog(page);
  const inDialog = dialog !== null;
  if (dialog && !await dialog.isVisible().catch(() => false)) {
    throw new ComposerError('the composer dialog is no longer open',
      'the post was NOT sent — the composer closed or was replaced before Post was '
      + 'clicked. Check the screenshot in data/media/diagnostics');
  }
  const scope: Page | Locator = dialog ?? page;
  if (!dialog) log('    [warn] no composer dialog (full-page listing form) — looking for Post on the page');

  // Poll rather than check once: Post stays disabled while the image uploads.
  const deadline = Date.now() + 60_000;
  let button: Locator | null = null;
  while (Date.now() < deadline && !button) {
    for (const pattern of SELECTORS.submit) {
      const candidate = scope.getByRole('button', { name: pattern }).first();
      if (await candidate.isVisible().catch(() => false)
        && await candidate.isEnabled().catch(() => false)) {
        button = candidate;
        break;
      }
    }
    if (!button) await page.waitForTimeout(1000);
  }

  if (!button) {
    const clickables = await describeClickables(page);
    throw new ComposerError(
      'could not find an enabled Post button in the composer after 60s',
      'the post was NOT sent. Either the image never finished uploading or the '
      + 'button moved. What the page actually offers:\n'
      + (clickables.length ? clickables.map((c) => `      · ${c}`).join('\n') : '      (nothing clickable found)')
      + '\n      Add the right wording to SELECTORS.submit in src/runner/composers.ts',
    );
  }

  await pause(600, 1400); // a person reads it back before clicking
  await button.click();
  log('    clicked Post');

  // The dialog closing is the receipt. Without this, an unsubmitted post gets
  // logged as posted, which is worse than a visible failure: it silently starts
  // a cooldown for a group that never saw anything.
  if (inDialog) {
    // The pinned locator reads hidden when that element hides OR is removed,
    // and never jumps to another dialog — which a lazy "newest dialog" would.
    const closed = await dialog.waitFor({ state: 'hidden', timeout: 90_000 })
      .then(() => true).catch(() => false);
    if (!closed) {
      throw new ComposerError('the composer did not close after clicking Post',
        'the post probably did NOT go out — Facebook may be showing an error, a '
        + 'rules confirmation, or an admin-approval step inside the composer. '
        + 'Check the screenshot in data/media/diagnostics.');
    }
  } else {
    await page.waitForTimeout(5000);
  }
  pinnedDialogs.delete(page); // this post is done; the next composer pins afresh
  log('    composer closed — post submitted');
}

/** Normal group composer: caption plus image(s). */
export async function statusComposer(ctx: ComposerContext): Promise<void> {
  const { page, variant, log } = ctx;

  const opener = await findStatusOpener(page);
  await opener.click();
  await pause(800, 1800);

  // The caption must go into the composer and nowhere else. The first version
  // took `page.getByRole('textbox').first()` across the whole page, and a group
  // page carries a "Comment as <name>" box under other members' posts. If the
  // dialog was slow to mount, the ad caption was typed as a comment on a
  // stranger's post. So: wait for the dialog, look only inside it, skip any
  // comment box by name, and fail rather than fall back to the page.
  const dialog = await pinComposerDialog(page, 15_000);
  if (!dialog) {
    throw new ComposerError('the composer dialog did not open after clicking the composer button',
      'nothing was typed. Facebook may now open the composer inline or be slow to '
      + 'respond — check the screenshot in data/media/diagnostics before retrying');
  }
  const box = await composerTextbox(dialog, 15_000);
  if (!box) {
    throw new ComposerError('the composer dialog opened but has no text box',
      'nothing was typed. Check SELECTORS.commentTextbox and the screenshot in '
      + 'data/media/diagnostics — the editor may have changed its role');
  }
  await typeHumanely(box, variant.caption);
  log('    caption typed');

  await attachImages(page, dialog, variant.imagePaths, log);
}

/**
 * Find the status opener, failing fast if the group is really a buy-and-sell
 * group. See decideStatusOpener for why this is not simply firstVisible.
 *
 * It deliberately does NOT fall through to the listing composer: a listing
 * needs a title and price the status variant may not have, and silently
 * posting something else than what was configured is worse than stopping.
 */
async function findStatusOpener(page: Page, timeoutMs = 25_000, graceMs = 3_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  let listingSeenAt: number | null = null;

  while (Date.now() < deadline) {
    const status = await findVisible(page, 'button', SELECTORS.openStatusComposer);
    if (!status && listingSeenAt === null
      && await findVisible(page, 'button', SELECTORS.openListingComposer)) {
      listingSeenAt = Date.now();
    }
    const verdict = decideStatusOpener(
      status !== null, listingSeenAt === null ? null : Date.now() - listingSeenAt, graceMs);
    if (verdict === 'use-status') return status!;
    if (verdict === 'wrong-composer') {
      throw new ComposerError('this group shows "Sell Something" but no "Write something…" composer',
        'this looks like a buy-and-sell group — set its composer type to "listing" '
        + '(Marketplace) in the Groups tab');
    }
    await pause(750, 750);
  }

  // Timed out with neither opener: the generic error, with the page's wording.
  return firstVisible(page, 'button', SELECTORS.openStatusComposer, 'the group composer', 0);
}

/** Marketplace-style listing composer. */
export async function listingComposer(ctx: ComposerContext): Promise<void> {
  const { page, variant, log } = ctx;

  const opener = await firstVisible(page, 'button', SELECTORS.openListingComposer, 'the listing composer');
  await opener.click();
  await pause(1000, 2200);

  // Scope field lookups to the listing dialog, for the same reason as the
  // status composer. Unlike there, a missing dialog falls back to the page with
  // a warning rather than failing: some layouts open the listing form as a full
  // page, and the field patterns are anchored names ("Title", "Price") that no
  // comment box carries, so the page-wide risk is far smaller than "any
  // textbox". The combobox and attach steps use the same scope.
  const dialog = await pinComposerDialog(page, 10_000);
  const scope: Page | Locator = dialog ?? page;
  if (!dialog) log('    [warn] listing dialog not detected — looking for fields on the page');

  const fill = async (patterns: readonly RegExp[], value: string | null, what: string) => {
    if (!value) return;
    const field = await firstVisible(scope, 'textbox', patterns, what);
    await typeHumanely(field, value);
    log(`    ${what} set`);
  };

  await fill(SELECTORS.listingFields.title, variant.listingTitle, 'title');
  await fill(
    SELECTORS.listingFields.price,
    variant.listingPriceCents === null ? null : (variant.listingPriceCents / 100).toFixed(2),
    'price',
  );
  await fill(SELECTORS.listingFields.location, variant.listingLocation, 'location');
  await fill(SELECTORS.listingFields.description, variant.caption, 'description');

  if (variant.listingCategory) {
    // Category is a combobox rather than a text field, so it gets its own path.
    const combo = scope.getByRole('combobox').first();
    if (await combo.isVisible().catch(() => false)) {
      await combo.click();
      await pause(400, 900);
      // The option list renders in a popover portalled outside the dialog, so
      // this one lookup stays page-wide; it only runs right after our click.
      await page.getByRole('option', { name: new RegExp(variant.listingCategory, 'i') }).first()
        .click().catch(() => log(`    could not select category "${variant.listingCategory}" — set it by hand`));
    }
  }

  await attachImages(page, scope, variant.imagePaths, log);
}

export function composerFor(kind: 'status' | 'listing'): (ctx: ComposerContext) => Promise<void> {
  return kind === 'listing' ? listingComposer : statusComposer;
}
