/**
 * Turning a message variant into the text one person receives.
 */
import type { IgLead } from '../domain/types.ts';

/**
 * First name from an Instagram display name, or null when it does not look
 * like a person's name. "Thandi M 🌸" → "Thandi"; "CAPE TOWN EATS" → null.
 * Sending "Hi Cape," is worse than sending "Hi,".
 */
export function firstNameOf(displayName: string | null): string | null {
  if (!displayName) return null;
  const word = displayName.normalize('NFC').trim().split(/[\s|•·,/_\-]+/u)[0] ?? '';
  const letters = word.replace(/[^\p{L}'’]/gu, '');
  // A name: 2–20 letters, not shouting (all-caps reads as a brand), no digits.
  if (letters.length < 2 || letters.length > 20) return null;
  if (letters !== word.replace(/[^\p{L}\p{N}'’]/gu, '')) return null;
  if (letters.length > 3 && letters === letters.toUpperCase()) return null;
  return letters[0]!.toUpperCase() + letters.slice(1);
}

/**
 * Fill {first_name} and {username}. An empty first name takes the space or
 * comma before it with it, so "Hi {first_name}, …" becomes "Hi, …" and
 * "Hey {first_name}!" becomes "Hey!".
 */
export function renderMessage(text: string, lead: Pick<IgLead, 'displayName' | 'username'>): string {
  const first = firstNameOf(lead.displayName);
  let out = text.replace(/\{username\}/gi, lead.username);
  out = first
    ? out.replace(/\{first_name\}/gi, first)
    : out.replace(/[ \t]*\{first_name\}/gi, '');
  return out.replace(/[ \t]+([,!.?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Placeholders a variant may use; anything else in braces is a typo. */
export const PLACEHOLDERS = ['first_name', 'username'] as const;

export function unknownPlaceholders(text: string): string[] {
  const found = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!.toLowerCase());
  return [...new Set(found.filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p)))];
}
