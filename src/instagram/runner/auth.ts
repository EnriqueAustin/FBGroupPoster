/**
 * Instagram sign-in detection, and the Chrome profile Instagram works in.
 *
 * The browser itself (launch, profile directory, the wait-for-the-human loop)
 * is shared and lives in core/browser.ts; only the "is this Instagram session
 * really signed in?" judgement belongs here.
 *
 * Instagram gets its OWN Chrome profile rather than sharing Facebook's. They
 * are the same company, but a job lane is one profile (see core/jobs.ts), and
 * sharing one would mean Instagram work could never run beside a Facebook
 * round. It also keeps a Facebook checkpoint from putting the Instagram
 * session in front of the human mid-run.
 */
import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { DEFAULT_PROFILE_DIRNAME, waitForSignIn } from '../../core/browser.ts';
import { IG_HOME } from './selectors.ts';
import { handleFromHref } from './parse.ts';

/** `.browser-profile-instagram` next to Facebook's profiles. Gitignored. */
export function igProfileDir(projectRoot = process.cwd()): string {
  return path.join(projectRoot, `${DEFAULT_PROFILE_DIRNAME}-instagram`);
}

/** The job lane Instagram work runs in — one Chrome profile, one job. */
export const IG_LANE = { key: 'instagram', label: 'Instagram' } as const;

export interface LoginOptions {
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Open instagram.com and wait until the human has signed in. */
export function login(context: BrowserContext, opts: LoginOptions = {}): Promise<boolean> {
  return waitForSignIn(context, {
    url: IG_HOME,
    siteName: 'Instagram',
    isLoggedIn,
    challengeUrl: /two_factor|two_step|challenge|checkpoint/i,
    ...opts,
  });
}

/**
 * URLs that mean authentication is still in progress. Checked BEFORE the
 * cookie, for the same reason as on the Facebook side: Instagram sets
 * `sessionid` once the password is accepted, while two-factor is still
 * outstanding. Trusting the cookie first would declare success mid-2FA and
 * race ahead to scrape nothing.
 */
const AUTH_IN_PROGRESS = [
  '/accounts/login', '/accounts/signup', '/accounts/password', '/accounts/suspended',
  '/accounts/disabled', '/challenge', '/two_factor', '/two_step', '/checkpoint',
];

/** DOM text for a 2FA / code-entry screen, which has no password field. */
const AUTH_PROMPT_TEXT = [
  'two-factor', 'two factor', 'security code', 'login code', 'enter the code',
  'we sent a code', 'confirm it’s you', "confirm it's you", 'authentication app',
  'approve your login', 'check your notifications', 'enter the 6-digit code',
  'help us confirm', 'save your login info',
];

export interface AuthSignals {
  url: string;
  hasLoginForm: boolean;
  bodyText: string;
  hasSessionCookie: boolean;
}

/**
 * The decision, split out from the browser so it can be tested directly.
 * Order matters: every "not yet" signal is checked before the one positive
 * signal. Conservative on purpose — a false negative only means waiting
 * longer, a false positive wrecks the run.
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
  const loginForm = page.locator('input[name="password"], input[name="username"]');
  const cookies = await page.context().cookies(IG_HOME);

  return decideLoggedIn({
    url: page.url(),
    hasLoginForm: (await loginForm.count().catch(() => 0)) > 0,
    bodyText: await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
    // `sessionid` is the session. `ds_user_id` alone is set earlier and is not
    // enough; requiring sessionid is the conservative half of this check.
    hasSessionCookie: cookies.some((c) => c.name === 'sessionid' && c.value.length > 0),
  });
}

/**
 * The signed-in account's own handle, for the harvest pre-filter (never DM
 * yourself). Read from the profile link in the navigation, which carries it
 * even when the avatar menu is closed. Null when it cannot be read — the
 * pre-filter treats that as "unknown", not as a match.
 */
export async function ownHandle(page: Page): Promise<string | null> {
  const handle = await page.evaluate(() => {
    const href = document.querySelector<HTMLAnchorElement>('a[href^="/"][role="link"][tabindex]')?.getAttribute('href');
    const nav = Array.from(document.querySelectorAll<HTMLAnchorElement>('nav a[href^="/"], [role="navigation"] a[href^="/"]'))
      .map((a) => a.getAttribute('href'))
      .find((h) => h && /^\/[^/]+\/$/.test(h) && !/^\/(explore|direct|reels?|accounts)\//.test(h));
    return nav ?? href ?? null;
  }).catch(() => null);
  return handle ? handleFromHref(handle) : null;
}
