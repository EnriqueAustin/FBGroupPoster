/**
 * Facebook sign-in detection.
 *
 * The browser itself (launch, profile, the wait-for-the-human loop) is shared
 * and lives in core/browser.ts; only the "is this Facebook session really
 * signed in?" judgement is Facebook's own.
 */
import type { BrowserContext, Page } from 'playwright';
import { waitForSignIn } from '../../core/browser.ts';

/** Facebook entry points we care about. */
export const FACEBOOK_HOME = 'https://www.facebook.com/';
export const FACEBOOK_GROUPS_JOINED = 'https://www.facebook.com/groups/joins/';

export interface LoginOptions {
  /** How long to wait for the human to finish signing in. Default 10 minutes. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Open facebook.com and wait until the human has signed in. */
export function login(context: BrowserContext, opts: LoginOptions = {}): Promise<boolean> {
  return waitForSignIn(context, {
    url: FACEBOOK_HOME,
    siteName: 'Facebook',
    isLoggedIn,
    challengeUrl: /two_step|two_factor|checkpoint|authentication|challenge/i,
    ...opts,
  });
}

/**
 * URLs that mean "authentication is still in progress". These must be checked
 * BEFORE the cookie, because Facebook sets `c_user` as soon as the password is
 * accepted — while two-factor is still outstanding. Trusting the cookie first
 * made the tool declare success mid-2FA, race ahead to scrape, find nothing,
 * and close the browser window out from under the user.
 */
const AUTH_IN_PROGRESS = [
  '/login', '/checkpoint', '/recover', '/two_step_verification', '/two_factor',
  '/authentication', '/challenge', '/confirmemail', '/device-based/',
];

/** DOM signals for a 2FA / code-entry screen, which has no email field. */
const AUTH_PROMPT_TEXT = [
  'two-factor', 'two factor', 'login code', 'security code', 'enter the code',
  'check your notifications', 'approve from another device', 'confirm your identity',
  'we sent a code', 'authentication app',
];

/**
 * "Are we fully signed in?"
 *
 * Conservative on purpose: a false negative just means waiting a little longer,
 * while a false positive wrecks the run. Every check below can only ever say
 * "not yet"; the cookie is the single positive signal, and only once nothing
 * else objects.
 */
export interface AuthSignals {
  url: string;
  hasLoginForm: boolean;
  bodyText: string;
  hasSessionCookie: boolean;
}

/**
 * The decision, split out from the browser so it can be tested directly.
 * Order matters: every "not yet" signal is checked before the one positive
 * signal, because `c_user` appears while two-factor is still outstanding.
 */
export function decideLoggedIn(s: AuthSignals): boolean {
  const url = s.url.toLowerCase();
  if (AUTH_IN_PROGRESS.some((frag) => url.includes(frag))) return false;
  if (s.hasLoginForm) return false;

  const text = s.bodyText.toLowerCase();
  if (AUTH_PROMPT_TEXT.some((frag) => text.includes(frag))) return false;

  return s.hasSessionCookie;
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  const loginForm = page.locator('input[name="email"], input#email, input[name="pass"]');
  const cookies = await page.context().cookies('https://www.facebook.com');

  return decideLoggedIn({
    url: page.url(),
    hasLoginForm: (await loginForm.count().catch(() => 0)) > 0,
    bodyText: await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
    hasSessionCookie: cookies.some((c) => c.name === 'c_user' && c.value.length > 0),
  });
}
