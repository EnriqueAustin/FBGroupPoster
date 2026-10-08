/**
 * Acting as a Facebook Page instead of the personal profile.
 *
 * Facebook's "New Pages Experience" lets the signed-in person switch the whole
 * session into a Page they manage (avatar menu → the Page, or "Switch now" on
 * the Page itself). While switched, the session carries an `i_user` cookie
 * holding the Page's id; without it, the session is the personal profile.
 * That cookie is the only signal used here to decide who we are acting as —
 * page text varies by language and layout, the cookie does not.
 *
 * Switching uses the same buttons a person would click. If they cannot be
 * found (Facebook moves them regularly), the human is asked to switch by hand
 * and the cookie is checked again afterwards. Nothing is ever posted unless
 * the switch is confirmed: a Page's ad going out from the personal profile, or
 * the reverse, is a mistake that cannot be taken back.
 */
import type { BrowserContext, Page } from 'playwright';
import type { Identity } from '../domain/types.ts';
import { FACEBOOK_HOME } from './auth.ts';

const ACTING_AS_COOKIE = 'i_user';

/** The Page id the session is acting as, or null when it is the personal profile. */
export async function actingAs(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies('https://www.facebook.com');
  const c = cookies.find((x) => x.name === ACTING_AS_COOKIE && x.value.length > 0);
  return c ? c.value : null;
}

/**
 * Is the session already acting as `identity`? Pure, so it can be tested.
 *
 * A Page whose id we have never learned cannot be confirmed from the cookie
 * alone — the session could be acting as a different Page — so that case
 * always answers false and the caller switches explicitly.
 */
export function isActingAs(actingId: string | null, identity: Pick<Identity, 'kind' | 'fbPageId'>): boolean {
  if (identity.kind === 'profile') return actingId === null;
  return actingId !== null && identity.fbPageId !== null && actingId === identity.fbPageId;
}

export interface SwitchOptions {
  log?: (msg: string) => void;
  /**
   * Ask the human to switch by hand. Resolves true when they say they have,
   * false to give up. Without it, a failed automatic switch is final.
   */
  askHuman?: (identity: Identity) => Promise<boolean>;
}

export type SwitchResult =
  | { ok: true; /** Set when the Page's id was not known before this switch. */ learnedFbPageId?: string }
  | { ok: false; error: string };

/** Wait for the acting-as cookie to satisfy `want`, polling. */
async function waitForActing(
  context: BrowserContext, page: Page, want: (id: string | null) => boolean, timeoutMs: number,
): Promise<string | null | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await actingAs(context);
    if (want(id)) return id;
    await page.waitForTimeout(1000);
  }
  return undefined;
}

async function toProfile(context: BrowserContext, page: Page, log: (m: string) => void): Promise<boolean> {
  if ((await actingAs(context)) === null) return true;
  log('    switching back to your personal profile…');
  // Dropping the cookie is what the avatar menu's "switch to <your name>"
  // amounts to. Reload so Facebook re-renders as the profile, then confirm it
  // did not hand the cookie straight back.
  await context.clearCookies({ name: ACTING_AS_COOKIE });
  await page.goto(FACEBOOK_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return (await waitForActing(context, page, (id) => id === null, 5_000)) !== undefined;
}

/** Click whatever "switch into this Page" control the Page shows. */
async function clickSwitch(page: Page, identity: Identity): Promise<boolean> {
  const candidates = [
    page.getByRole('button', { name: /^switch now$/i }),
    page.getByRole('button', { name: new RegExp(`^switch (in)?to ${escapeRe(identity.name)}`, 'i') }),
    page.getByRole('button', { name: /^switch$/i }),
    page.getByText(/^switch now$/i),
  ];
  for (const c of candidates) {
    const first = c.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      // Some accounts get a confirmation dialog ("Switch to X?") first.
      const confirm = page.getByRole('dialog').getByRole('button', { name: /^switch$/i }).first();
      if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
      return true;
    }
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Make the session act as `identity`, confirming it via the cookie.
 *
 * For a Page: from any other identity (including a different Page) go back to
 * the profile first, open the Page, and press its switch control. A Page
 * cannot switch straight into another Page, and starting from the profile
 * every time keeps this one path instead of several.
 */
export async function ensureIdentity(
  context: BrowserContext, page: Page, identity: Identity, opts: SwitchOptions = {},
): Promise<SwitchResult> {
  const log = opts.log ?? (() => {});
  if (isActingAs(await actingAs(context), identity)) return { ok: true };

  if (identity.kind === 'profile') {
    if (await toProfile(context, page, log)) return { ok: true };
    if (opts.askHuman && await opts.askHuman(identity) && (await actingAs(context)) === null) {
      return { ok: true };
    }
    return { ok: false, error: 'could not switch the browser back to your personal profile' };
  }

  // --- a Page ---
  if (!(await toProfile(context, page, log))) {
    return { ok: false, error: `could not leave the current Page to switch into ${identity.name}` };
  }

  const confirmed = (id: string | null) =>
    id !== null && (identity.fbPageId === null || id === identity.fbPageId);

  let acting: string | null | undefined;
  if (identity.pageUrl) {
    log(`    switching to ${identity.name}…`);
    await page.goto(identity.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_500);
    if (await clickSwitch(page, identity)) {
      acting = await waitForActing(context, page, confirmed, 20_000);
    } else {
      log(`    no "Switch now" button found on ${identity.pageUrl}`);
    }
  }

  if (acting === undefined && opts.askHuman) {
    if (await opts.askHuman(identity)) {
      acting = await waitForActing(context, page, confirmed, 5_000);
    }
  }

  if (acting === undefined || acting === null) {
    const now = await actingAs(context);
    return {
      ok: false,
      error: now !== null && identity.fbPageId !== null
        ? `the browser is acting as a different Page (${now}), not ${identity.name} (${identity.fbPageId})`
        : `could not switch the browser to ${identity.name}`,
    };
  }

  log(`    now acting as ${identity.name}`);
  return identity.fbPageId === null ? { ok: true, learnedFbPageId: acting } : { ok: true };
}
