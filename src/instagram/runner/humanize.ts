/**
 * Pacing and typing, so the runner reads as a person rather than a script.
 *
 * This is not an evasion layer and must not become one — no fingerprint
 * spoofing, no proxies, no patching `navigator.webdriver`. It exists because
 * the actions here are ones a person does at a person's speed: the gaps
 * between them are set by the planner (minutes apart), and this module only
 * covers the small pauses *within* one action — the beat before clicking a
 * button you have just read, the rhythm of typing a sentence.
 *
 * It also serves correctness. Instagram's message box is a rich-text editor
 * that drops text set in one operation, so typing per character is the only
 * reliable way in.
 */
import type { Locator, Page } from 'playwright';

/** A pause of between `min` and `max` milliseconds. */
export function pause(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

/** The beat between reading something and acting on it. */
export const beat = (): Promise<void> => pause(400, 1200);

/**
 * Type text the way a person does: per character, with a varying rhythm and a
 * longer beat after sentence breaks.
 *
 * Newlines are inserted with Shift+Enter: in a DM thread a bare Enter sends
 * the message, which in assisted mode would send it without the human ever
 * seeing it.
 */
export async function typeHumanely(box: Locator, text: string): Promise<void> {
  await box.click();
  await pause(200, 600);
  // \r?\n: a message saved from a Windows textarea arrives with CRLF, and a
  // stray '\r' would otherwise be pressed as a key of its own.
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const ch of line) {
      await box.press(ch === ' ' ? 'Space' : ch, { delay: 20 + Math.random() * 70 })
        .catch(async () => { await box.type(ch, { delay: 30 }); });
      if ('.!?'.includes(ch)) await pause(150, 400);
    }
    if (i < lines.length - 1) {
      await pause(200, 500);
      await box.press('Shift+Enter').catch(() => undefined);
    }
  }
}

/**
 * Scroll a scrollable container (or the window) down one screen and report
 * whether anything new came in. Instagram's people lists are virtualised: the
 * only way to see the hundredth liker is to scroll, and the only way to know
 * the list has ended is that the height stopped changing.
 */
export async function scrollStep(page: Page, containerSelector: string | null): Promise<{ grew: boolean }> {
  const before = await measure(page, containerSelector);
  await page.evaluate((sel) => {
    const el = sel ? document.querySelector<HTMLElement>(sel) : null;
    if (el) el.scrollTop = el.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);
  }, containerSelector);
  await pause(700, 1500);
  const after = await measure(page, containerSelector);
  return { grew: after > before };
}

function measure(page: Page, containerSelector: string | null): Promise<number> {
  return page.evaluate((sel) => {
    const el = sel ? document.querySelector<HTMLElement>(sel) : null;
    return el ? el.scrollHeight : document.body.scrollHeight;
  }, containerSelector).catch(() => 0);
}

/**
 * Find the first visible element whose accessible name matches one of
 * `patterns`, or null. Patterns are whole-string regexes from SELECTORS, which
 * is the only place they should be written.
 */
export async function findByName(
  page: Page,
  role: 'button' | 'link' | 'textbox',
  patterns: readonly RegExp[],
  timeoutMs = 4000,
): Promise<Locator | null> {
  for (const pattern of patterns) {
    const candidate = page.getByRole(role, { name: pattern }).first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: timeoutMs / patterns.length });
      return candidate;
    } catch {
      // Next pattern. Instagram rewords these constantly, which is why there
      // is a list rather than one selector.
    }
  }
  return null;
}

/**
 * Close the "Turn on Notifications" / "Add Instagram to your Home screen"
 * dialogs. They cover the page and swallow clicks, and they appear at
 * unpredictable moments rather than only on first load.
 */
export async function dismissNags(page: Page, patterns: readonly RegExp[]): Promise<void> {
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.isVisible().catch(() => false))) return;
  for (const pattern of patterns) {
    const button = dialog.getByRole('button', { name: pattern }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2000 }).catch(() => undefined);
      await pause(300, 700);
      return;
    }
  }
}
