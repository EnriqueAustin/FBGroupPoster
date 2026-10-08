/**
 * Recognising when Instagram has pushed back.
 *
 * This is the input to the IG circuit breaker, which is sticky: one match
 * stops every Instagram job until a human clears it. Biased towards false
 * positives on purpose — stopping for nothing costs a few follows, while
 * carrying on through a real "action blocked" is how a temporary restriction
 * becomes a permanent one. Instagram is markedly less forgiving than Facebook
 * groups about exactly the pattern this module exists to protect (following
 * and messaging strangers in volume), so the bias is set harder here.
 *
 * As on the Facebook side, that bias only holds if the text matched is text
 * INSTAGRAM wrote. A profile's bio, a post's caption and a comment thread all
 * contain arbitrary words, and "try again later" turns up in ordinary
 * captions. So page text is gathered only from dialogs, alerts and toasts,
 * plus the whole body on a screen that is not showing someone else's content
 * (see selectBlockText). URLs are always matched in full.
 *
 * NOTE FOR FUTURE MAINTENANCE: these patterns WILL rot. When the tool sails
 * through a block, or stops for no reason, this file is the first place to
 * look.
 */
import type { Page } from 'playwright';

/**
 * What kind of pushback. Every kind here is account-wide: unlike a Facebook
 * group, there is no "this one audience refused you" case — a restriction on
 * following or messaging applies to the whole account.
 */
export type IgBlockKind =
  | 'action-blocked'   // "Action Blocked" / "We restrict certain activity"
  | 'rate-limit'       // "Please wait a few minutes before you try again"
  | 'challenge'        // /challenge/, "confirm your identity"
  | 'login-required'   // bounced to the login page mid-run
  | 'account-disabled' // suspended or disabled: stop, and do not retry
  | 'dm-restricted';   // messaging specifically refused

export interface IgBlockSignal {
  kind: IgBlockKind;
  /** Matched against the lowercased selected page text. */
  text?: string[];
  /** Matched against the lowercased URL. */
  url?: string[];
}

/**
 * Text is matched case-insensitively as a substring, so short distinctive
 * fragments survive rewording better than whole sentences.
 *
 * ORDER MATTERS: the first match wins, most serious first. A disabled account
 * must never be reported as a mere rate limit.
 */
export const IG_BLOCK_SIGNALS: readonly IgBlockSignal[] = [
  {
    kind: 'account-disabled',
    url: ['/accounts/suspended', '/accounts/disabled'],
    text: [
      'your account has been disabled',
      'your account has been suspended',
      'we suspended your account',
      'account has been deactivated',
    ],
  },
  {
    kind: 'challenge',
    url: ['/challenge/', '/checkpoint/'],
    text: [
      'confirm your identity',
      'help us confirm',
      'suspicious login attempt',
      'we detected unusual activity',
      'please verify your account',
      'confirm that it was you',
    ],
  },
  {
    kind: 'login-required',
    url: ['/accounts/login'],
    text: [
      'log in to continue',
      'you need to log in',
      'please log in again',
    ],
  },
  {
    kind: 'action-blocked',
    text: [
      'action blocked',
      'we restrict certain activity',
      'this action was blocked',
      'you cannot perform this action',
      'you can’t perform this action',
      "you can't perform this action",
      'your account has been temporarily blocked',
      'temporarily blocked',
      'we limit how often',
      'this block will expire',
      'tell us if you think we made a mistake',
    ],
  },
  {
    kind: 'dm-restricted',
    text: [
      'you cannot message this account',
      "you can't message this account",
      'this account is restricted',
      'messaging is unavailable',
      'cannot send message',
      "couldn't send your message",
      'your message could not be sent',
    ],
  },
  {
    kind: 'rate-limit',
    text: [
      'please wait a few minutes before you try again',
      'please wait a few minutes',
      'try again later',
      'slow down',
      "you're going too fast",
      'limit reached',
      'too many requests',
    ],
  },
];

export interface IgBlockResult {
  blocked: boolean;
  kind?: IgBlockKind;
  reason?: string;
}

/**
 * Pure matcher, so the patterns can be tested without a browser.
 *
 * Unlike the Facebook side there is no restricted channel for toast text:
 * every kind here is account-wide and worth stopping for, and Instagram
 * delivers "Action Blocked" as a dialog and "Please wait a few minutes" as a
 * toast. Both must count.
 */
export function matchIgBlock(url: string, visibleText: string): IgBlockResult {
  const u = url.toLowerCase();
  const t = visibleText.toLowerCase();

  for (const signal of IG_BLOCK_SIGNALS) {
    for (const fragment of signal.url ?? []) {
      if (u.includes(fragment)) {
        return { blocked: true, kind: signal.kind, reason: `URL matched "${fragment}" (${signal.kind})` };
      }
    }
    for (const fragment of signal.text ?? []) {
      if (t.includes(fragment)) {
        return { blocked: true, kind: signal.kind, reason: `page said "${fragment}" (${signal.kind})` };
      }
    }
  }
  return { blocked: false };
}

/**
 * A disabled or suspended account is not something to retry at all: clearing
 * the breaker and carrying on would be the wrong thing for a human to do, so
 * the UI says so differently. Everything else is "wait, look, then decide".
 */
export function isTerminal(kind: IgBlockKind): boolean {
  return kind === 'account-disabled';
}

/** Raw material gathered from the live page; see selectBlockText. */
export interface IgBlockSurfaces {
  /** innerText of every dialog / alertdialog / alert / status region. */
  overlayTexts: string[];
  /**
   * Whether the page is showing other people's content — a feed, a post, a
   * list of people. When it is, the body text is other people's words and
   * must not be matched.
   */
  hasForeignContent: boolean;
  /** document.body.innerText. Only used when there is no foreign content. */
  bodyText: string;
}

/**
 * Decide which text counts as Instagram talking to us. Pure, so the rule can
 * be tested without a browser.
 *
 * - Overlays always count: "Action Blocked" is a dialog, and "Please wait a
 *   few minutes" is a toast in a status region. Both are Instagram's own UI.
 * - The whole body counts only on a screen with no foreign content.
 *   Challenges, suspensions and the login wall are full-page screens; a
 *   profile or a likes list is mostly other people's text.
 */
export function selectBlockText(s: IgBlockSurfaces): string {
  const parts = [...s.overlayTexts];
  if (!s.hasForeignContent) parts.push(s.bodyText);
  return parts.join('\n');
}

/** Runs in the browser. Collects the surfaces selectBlockText chooses from. */
async function gatherSurfaces(page: Page): Promise<IgBlockSurfaces> {
  return page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"]',
    ));
    // A feed, an article (a post), or a list of people: all other people's
    // content. The login and challenge screens have none of these.
    const hasForeignContent = document.querySelector(
      '[role="feed"], article, main [role="list"], [role="main"] article',
    ) !== null;
    return {
      overlayTexts: overlays.map((el) => el.innerText ?? ''),
      hasForeignContent,
      bodyText: hasForeignContent ? '' : (document.body?.innerText ?? ''),
    };
  });
}

export async function detectIgBlock(page: Page): Promise<IgBlockResult> {
  let surfaces: IgBlockSurfaces;
  try {
    surfaces = await gatherSurfaces(page);
  } catch {
    // A page mid-navigation throws here, which is exactly when a redirect to
    // /challenge/ happens. The URL is still readable.
    return matchIgBlock(page.url(), '');
  }
  return matchIgBlock(page.url(), selectBlockText(surfaces));
}
