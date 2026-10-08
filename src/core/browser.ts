/**
 * Browser lifecycle for the runner.
 *
 * Design notes:
 * - We use a PERSISTENT context (a real on-disk Chrome profile under
 *   `.browser-profile/`) so the human logs in once, by hand, and the session
 *   cookie survives restarts. This app never sees, stores or types credentials.
 * - `headless: false` is not configurable. The whole product is "assisted
 *   posting": the human must be able to watch what happens and take over the
 *   keyboard at any moment. A headless mode would only be useful for doing
 *   this behind the user's back, which is explicitly out of scope.
 * - We do NOT install stealth plugins, patch `navigator.webdriver`, spoof
 *   fingerprints or rotate proxies. If Facebook decides to challenge us, the
 *   correct answer is to stop and let the human deal with it (see detect.ts).
 */
import { chromium } from 'playwright';
import type { BrowserContext, LaunchOptions, Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

export interface BrowserOptions {
  /** Project root; the profile lives in `<projectRoot>/.browser-profile`. */
  projectRoot?: string;
  /** Override the profile directory outright (tests, multiple personas). */
  profileDir?: string;
  /** Slow every Playwright action down by N ms. Helps the human follow along. */
  slowMoMs?: number;
  /** Viewport of the visible window. Null = use the OS window size. */
  viewport?: { width: number; height: number } | null;
  /** Where log lines go. Defaults to console.log. */
  log?: (msg: string) => void;
}

export interface RunnerBrowser {
  context: BrowserContext;
  /** The profile directory actually used. */
  profileDir: string;
  /** True when we fell back to Playwright's bundled Chromium. */
  usedBundledChromium: boolean;
  close(): Promise<void>;
}

export const DEFAULT_PROFILE_DIRNAME = '.browser-profile';

/**
 * The Chrome profile an identity works in.
 *
 * One per identity, because "acting as a Page" is a cookie on the whole
 * Facebook session: two runs sharing a profile would keep switching each other
 * between the profile and the Page mid-post. With a profile each, a Page's
 * window stays switched into that Page and a round as the Page can run beside
 * a round as the profile. The personal profile keeps the original directory so
 * its existing sign-in carries on; each Page's profile is signed into once.
 *
 * Typed structurally rather than against Facebook's `Identity`: core knows
 * about browser profiles, not about who a module is posting as.
 */
export function profileDirFor(
  identity: { id: number | string; kind: string } | null | undefined,
  projectRoot = process.cwd(),
): string {
  return !identity || identity.kind === 'profile'
    ? path.join(projectRoot, DEFAULT_PROFILE_DIRNAME)
    : path.join(projectRoot, `${DEFAULT_PROFILE_DIRNAME}-page-${identity.id}`);
}

function defaultLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

/**
 * Launch (or re-attach to) the persistent Chromium context.
 *
 * We first try `channel: 'chrome'` — the user's real installed Chrome, which
 * behaves closest to what they see day to day. If Chrome is not installed we
 * fall back to Playwright's bundled Chromium. That is a compatibility
 * fallback, not an evasion technique.
 */
export async function launchBrowser(opts: BrowserOptions = {}): Promise<RunnerBrowser> {
  const log = opts.log ?? defaultLog;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const profileDir = opts.profileDir ?? path.join(projectRoot, DEFAULT_PROFILE_DIRNAME);

  fs.mkdirSync(profileDir, { recursive: true });

  const common: LaunchOptions & Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false, // deliberate and non-negotiable, see file header
    slowMo: opts.slowMoMs ?? 0,
    viewport: opts.viewport === undefined ? { width: 1400, height: 950 } : opts.viewport,
    args: [
      // Suppress the "Chrome is being controlled by automated test software"
      // *infobar* only. This is cosmetic — it stops the bar from covering the
      // page the human needs to read. It does not hide automation from the
      // site (navigator.webdriver is left exactly as Playwright sets it).
      '--disable-infobars',
      '--start-maximized',
    ],
  };

  let context: BrowserContext;
  let usedBundledChromium = false;
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...common, channel: 'chrome' });
    log(`[browser] launched installed Chrome with profile ${profileDir}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    log(`[browser] installed Chrome unavailable (${reason}); falling back to bundled Chromium`);
    context = await chromium.launchPersistentContext(profileDir, common);
    usedBundledChromium = true;
    log(`[browser] launched bundled Chromium with profile ${profileDir}`);
  }

  // Generous default: Facebook is slow and the human may be interacting.
  context.setDefaultTimeout(45_000);
  context.setDefaultNavigationTimeout(60_000);

  return {
    context,
    profileDir,
    usedBundledChromium,
    async close() {
      await context.close();
    },
  };
}

/** Return the first open page, or open one. Persistent contexts start with one. */
export async function firstPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) return existing;
  return context.newPage();
}

export interface SignInOptions {
  /** Page to open; the human signs in there. */
  url: string;
  /** Human name of the site for log lines, e.g. "Facebook". */
  siteName: string;
  /**
   * Site-specific "fully signed in?" check. Must be conservative: a false
   * negative only means waiting longer, a false positive wrecks the run.
   */
  isLoggedIn: (page: Page) => Promise<boolean>;
  /** URL fragments that mean a 2FA / challenge step is on screen. */
  challengeUrl?: RegExp;
  /** How long to wait for the human to finish signing in. Default 10 minutes. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Open a site and wait until the human has signed in.
 *
 * THE APP NEVER HANDLES CREDENTIALS. There is no username/password option
 * anywhere in this codebase by design: the human types them into the real
 * Chrome window, and the persistent profile keeps the session afterwards.
 */
export async function waitForSignIn(context: BrowserContext, opts: SignInOptions): Promise<boolean> {
  const log = opts.log ?? defaultLog;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const page = await firstPage(context);

  await page.goto(opts.url, { waitUntil: 'domcontentloaded' });

  if (await opts.isLoggedIn(page)) {
    log('[browser] already signed in (existing profile session).');
    return true;
  }

  log('');
  log('='.repeat(70));
  log(`  SIGN IN TO ${opts.siteName.toUpperCase()} IN THE BROWSER WINDOW THAT JUST OPENED.`);
  log('  This app never asks for, stores or types your password.');
  log('  Complete any 2FA there too. Waiting up to ' + Math.round(timeoutMs / 60000) + ' minutes...');
  log('='.repeat(70));
  log('');

  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  let announced = false;

  while (Date.now() < deadline) {
    const ok = await opts.isLoggedIn(page).catch(() => false);

    if (ok) {
      // Require the signal to hold across three checks ~2s apart. Sign-in
      // bounces through several intermediate URLs, and any one of them can
      // momentarily look settled.
      consecutive++;
      if (consecutive >= 3) {
        log('[browser] sign-in confirmed. Session stored in the profile directory.');
        return true;
      }
    } else {
      if (consecutive > 0) log('[browser] still finishing sign-in…');
      consecutive = 0;
      if (!announced && opts.challengeUrl?.test(page.url())) {
        log('[browser] two-factor step detected — take your time, approve it on your phone.');
        log('[browser] the window stays open and nothing happens until you are through.');
        announced = true;
      }
    }
    await page.waitForTimeout(2_000);
  }

  log(`[browser] timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for sign-in.`);
  return false;
}
