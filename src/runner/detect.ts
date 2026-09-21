/**
 * Recognising when Facebook has pushed back.
 *
 * This is the input to the circuit breaker, so it is deliberately biased
 * towards false positives: stopping when nothing was wrong costs you one
 * posting slot, while missing a real block and carrying on is how a temporary
 * restriction turns into a permanent one.
 *
 * That bias only holds if the text we match is text FACEBOOK wrote. It used to
 * be the whole page body, which on a group page is mostly other members'
 * posts — and "slow down", "try again later" and "security check" turn up in
 * ordinary posts often enough to trip the breaker for nothing. So text is now
 * gathered only from the places these messages actually appear (see
 * selectBlockText); URLs are still matched in full.
 *
 * NOTE FOR FUTURE MAINTENANCE: these patterns WILL rot. Facebook rewords and
 * restructures these screens regularly. When the tool starts sailing through a
 * block, or stopping for no reason, this file is the first place to look.
 */
import type { Page } from 'playwright';
import type { BlockKind } from '../domain/types.ts';

// Re-exported so runner code and tests keep importing it from here.
export type { BlockKind };

export interface BlockSignal {
  kind: BlockKind;
  /** Matched against the lowercased visible text of the page. */
  text?: string[];
  /** Matched against the lowercased URL. */
  url?: string[];
}

/**
 * Text is matched case-insensitively as a substring, so short distinctive
 * fragments survive minor rewording better than whole sentences.
 *
 * ORDER MATTERS: the first match wins. Account-wide kinds come first so that a
 * page showing both a real block and a group-level message is treated as the
 * block. 'pending-approval' is last because it is good news — it must never
 * mask anything else on the page.
 */
export const BLOCK_SIGNALS: readonly BlockSignal[] = [
  { kind: 'checkpoint', url: ['/checkpoint/', '/confirmemail', '/recover/'] },
  { kind: 'login-required', url: ['/login/', '/login.php'] },
  {
    kind: 'temporary-block',
    text: [
      "you're temporarily blocked",
      'you are temporarily blocked',
      'temporarily restricted',
      'temporarily blocked from posting',
      'this feature is currently unavailable',
      "you can't use this feature right now",
      'you cannot use this feature right now',
      'blocked from using this feature',
    ],
  },
  {
    kind: 'rate-limit',
    text: [
      'you have been posting too',
      'posting too quickly',
      'slow down',
      "you're going too fast",
      'try again later',
    ],
  },
  {
    kind: 'captcha',
    text: [
      'security check',
      'confirm your identity',
      'please solve this puzzle',
      'prove you are human',
      'prove you are not a robot',
      'enter the characters',
    ],
  },
  {
    kind: 'group-restricted',
    text: [
      'you have been removed from this group',
      'you are no longer a member',
      "you can't post in this group",
      'only admins can post',
      'membership is required to post',
    ],
  },
  {
    // Split out of 'group-restricted', where it used to live. A post awaiting
    // admin approval HAS gone out — treating it as a refusal requeued it and
    // the group got the same ad twice. Kept to phrases about OUR post: plain
    // "pending approval" would also match a pending membership request, which
    // really is a restriction.
    kind: 'pending-approval',
    text: [
      'your post is pending',
      'pending admin approval',
      'post is awaiting approval',
    ],
  },
];

export interface BlockResult {
  blocked: boolean;
  kind?: BlockKind;
  reason?: string;
}

/** Pure matcher, so the patterns can be tested without a browser. */
export function matchBlock(url: string, visibleText: string): BlockResult {
  const u = url.toLowerCase();
  const t = visibleText.toLowerCase();

  for (const signal of BLOCK_SIGNALS) {
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
 * Whether this kind of pushback must stop the whole run (requeue the item and
 * trip the breaker), as opposed to affecting only the group in front of us.
 *
 * login-required counts as account-wide. Strictly it is not a restriction,
 * but in practice: (a) every remaining group would hit the same login wall,
 * so carrying on just burns the queue as failures; and (b) being logged out
 * in the middle of a run is one of the ways Facebook drops a session it has
 * become suspicious of. Both call for a human to look before anything else is
 * posted, which is exactly what the sticky breaker enforces.
 *
 * 'group-restricted' and 'pending-approval' concern one group only.
 */
export function isAccountWide(kind: BlockKind): boolean {
  return kind === 'temporary-block' || kind === 'checkpoint' || kind === 'captcha'
    || kind === 'rate-limit' || kind === 'login-required';
}

/** Raw material gathered from the live page; see gatherBlockSurfaces. */
export interface BlockSurfaces {
  /** innerText of every dialog / alertdialog / alert on the page. */
  overlayTexts: string[];
  /** Whether the page has a [role="feed"], i.e. is a feed of members' posts. */
  hasFeed: boolean;
  /** document.body.innerText. Only used when there is no feed. */
  bodyText: string;
}

/**
 * Decide which text is allowed to count as Facebook talking to us. Pure, so
 * the rule can be tested without a browser.
 *
 * - Overlays (dialog, alertdialog, alert) always count. Blocks, rate limits
 *   and "pending approval" notices are shown this way on top of a group page.
 * - The whole body counts only when there is no feed. Checkpoints, captchas
 *   and interstitial "you're blocked" pages are full-page screens with no
 *   feed; a group page's body is mostly members' posts and must be ignored.
 *
 * The cost: a group-level notice rendered inline on a feed page (e.g. "only
 * admins can post" in place of the composer) is no longer seen here. That
 * fails safe — the composer lookup then fails and the item is recorded as
 * 'failed' for that group, without tripping the breaker.
 */
export function selectBlockText(s: BlockSurfaces): string {
  const parts = [...s.overlayTexts];
  if (!s.hasFeed) parts.push(s.bodyText);
  return parts.join('\n');
}

/** Runs in the browser. Collects the surfaces selectBlockText chooses from. */
async function gatherBlockSurfaces(page: Page): Promise<BlockSurfaces> {
  return page.evaluate(() => {
    const overlays = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="alert"]'),
    );
    const hasFeed = document.querySelector('[role="feed"]') !== null;
    return {
      overlayTexts: overlays.map((el) => el.innerText ?? ''),
      hasFeed,
      // Skip the (large) body read when it would be thrown away anyway.
      bodyText: hasFeed ? '' : (document.body?.innerText ?? ''),
    };
  });
}

export async function detectBlock(page: Page): Promise<BlockResult> {
  let surfaces: BlockSurfaces;
  try {
    surfaces = await gatherBlockSurfaces(page);
  } catch {
    // A page mid-navigation can throw here. Fall back to the URL alone rather
    // than giving up: a redirect to /checkpoint/ is exactly when this tends to
    // happen, and the URL is still readable.
    return matchBlock(page.url(), '');
  }
  return matchBlock(page.url(), selectBlockText(surfaces));
}
