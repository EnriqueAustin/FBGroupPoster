/**
 * Tiny seeded PRNG (mulberry32).
 *
 * The plan must be reproducible: the user does a dry run, inspects it, then
 * commits. If `plan()` used Math.random the committed plan would differ from
 * the inspected one. Seeding also lets the tests assert real determinism
 * instead of "it did not crash".
 *
 * Not cryptographic — it only needs to be well-distributed and cheap.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick one element, or undefined for an empty array. */
  pick<T>(items: readonly T[]): T | undefined;
}

export function mulberry32(seed: number): Rng {
  // Force to uint32; a 0 seed is fine for mulberry32.
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int(min: number, max: number): number {
      if (max <= min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
  };
  return rng;
}

/**
 * Weighted pick. Non-positive weights are treated as 0; if every weight is 0
 * the choice degrades to uniform so a mis-configured ad still rotates.
 */
export function weightedPick<T>(rng: Rng, items: readonly T[], weightOf: (t: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  let total = 0;
  for (const it of items) total += Math.max(0, weightOf(it));
  if (total <= 0) return rng.pick(items);
  let r = rng.next() * total;
  for (const it of items) {
    r -= Math.max(0, weightOf(it));
    if (r < 0) return it;
  }
  return items[items.length - 1];
}
