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
  for (const line of text.split('\n')) {
    for (const ch of line) {
      await locator.press(ch === ' ' ? 'Space' : ch, { delay: 20 + Math.random() * 70 })
        .catch(async () => { await locator.type(ch, { delay: 30 }); });
      if ('.!?'.includes(ch)) await pause(150, 400);
    }
    // Shift+Enter keeps a newline from submitting the composer.
    await locator.press('Shift+Enter').catch(() => undefined);
  }
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
  page: Page,
  role: 'button' | 'textbox',
  patterns: readonly RegExp[],
  what: string,
  timeoutMs = 25_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const byRole = page.getByRole(role, { name: pattern }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;
      const byText = page.getByText(pattern).first();
      if (await byText.isVisible().catch(() => false)) return byText;
    }
    await page.waitForTimeout(750);
  }

  const clickables = await describeClickables(page);
  throw new ComposerError(
    `could not find ${what} after ${Math.round(timeoutMs / 1000)}s`,
    `tried ${patterns.map(String).join(', ')}. What the page actually offers:\n`
    + (clickables.length ? clickables.map((c) => `      · ${c}`).join('\n') : '      (nothing clickable found — page may not have loaded)')
    + '\n      Add the right wording to SELECTORS in src/runner/composers.ts',
  );
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
 */
async function attachImages(page: Page, imagePaths: string[], log: (m: string) => void): Promise<void> {
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
  const dialog = page.getByRole('dialog').first();
  const inDialog = await dialog.isVisible().catch(() => false);
  const scope = inDialog ? dialog : page;
  if (!inDialog) log('    [warn] composer dialog not detected — attaching against the page');

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
  const dialog = page.getByRole('dialog').first();
  const inDialog = await dialog.isVisible().catch(() => false);
  const scope = inDialog ? dialog : page;
  if (!inDialog) log('    [warn] composer dialog not detected — looking for Post on the page');

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
  log('    composer closed — post submitted');
}

/** Normal group composer: caption plus image(s). */
export async function statusComposer(ctx: ComposerContext): Promise<void> {
  const { page, variant, log } = ctx;

  const opener = await firstVisible(page, 'button', SELECTORS.openStatusComposer, 'the group composer');
  await opener.click();
  await pause(800, 1800);

  const box = page.getByRole('textbox').first();
  await box.waitFor({ state: 'visible', timeout: 15_000 });
  await typeHumanely(box, variant.caption);
  log('    caption typed');

  await attachImages(page, variant.imagePaths, log);
}

/** Marketplace-style listing composer. */
export async function listingComposer(ctx: ComposerContext): Promise<void> {
  const { page, variant, log } = ctx;

  const opener = await firstVisible(page, 'button', SELECTORS.openListingComposer, 'the listing composer');
  await opener.click();
  await pause(1000, 2200);

  const fill = async (patterns: readonly RegExp[], value: string | null, what: string) => {
    if (!value) return;
    const field = await firstVisible(page, 'textbox', patterns, what);
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
    const combo = page.getByRole('combobox').first();
    if (await combo.isVisible().catch(() => false)) {
      await combo.click();
      await pause(400, 900);
      await page.getByRole('option', { name: new RegExp(variant.listingCategory, 'i') }).first()
        .click().catch(() => log(`    could not select category "${variant.listingCategory}" — set it by hand`));
    }
  }

  await attachImages(page, variant.imagePaths, log);
}

export function composerFor(kind: 'status' | 'listing'): (ctx: ComposerContext) => Promise<void> {
  return kind === 'listing' ? listingComposer : statusComposer;
}
