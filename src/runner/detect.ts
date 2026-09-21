/**
 * Recognising when Facebook has pushed back.
 *
 * This is the input to the circuit breaker, so it is deliberately biased
 * towards false positives: stopping when nothing was wrong costs you one
 * posting slot, while missing a real block and carrying on is how a temporary
 * restriction turns into a permanent one.
 *
 * NOTE FOR FUTURE MAINTENANCE: these patterns WILL rot. Facebook rewords and
 * restructures these screens regularly. When the tool starts sailing through a
 * block, or stopping for no reason, this file is the first place to look.
 */
import type { Page } from 'playwright';

export type BlockKind =
  | 'temporary-block'
  | 'checkpoint'
  | 'captcha'
  | 'rate-limit'
  | 'login-required'
  | 'group-restricted';

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
      'your post is pending approval',
      'membership is required to post',
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
 * `group-restricted` and `login-required` are real problems but are not
 * account-wide, so callers may want to treat them differently from a
 * genuine posting block.
 */
export function isAccountWide(kind: BlockKind): boolean {
  return kind === 'temporary-block' || kind === 'checkpoint' || kind === 'captcha' || kind === 'rate-limit';
}

export async function detectBlock(page: Page): Promise<BlockResult> {
  let text = '';
  try {
    // Only the body text; attribute noise produces false positives.
    text = await page.evaluate(() => document.body?.innerText ?? '');
  } catch {
    // A page mid-navigation can throw here. Not evidence of a block.
    return { blocked: false };
  }
  return matchBlock(page.url(), text);
}
