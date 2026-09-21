/**
 * The scheduler.
 *
 * This is the safety-critical module. Everything it does exists to keep the
 * posting pattern below the thresholds that get an account restricted or get
 * you thrown out of a group by its admins. The rules, and why each one is here:
 *
 *   daily cap           volume is the thing Facebook actually counts
 *   per-group cooldown  what stops group admins removing you
 *   per-ad cooldown     stops members seeing the same ad in the same place
 *   randomised gaps     a fixed cadence is a machine signature
 *   active hours        nothing posts at 03:00
 *   variant rotation    identical text across groups is the strongest signal
 *   fairness ordering   spreads coverage instead of hammering the same groups
 *
 * plan() is pure: it reads the store and returns a Plan, mutating nothing. Given
 * the same store contents, `now` and `seed` it always produces the same result,
 * which is what makes the dry run trustworthy and the tests deterministic.
 */
import type { Plan, PlanExclusion, PlannedPost, Scheduler, Store } from '../domain/contracts.ts';
import type { Ad, Business, Group, Id, QueueItem } from '../domain/types.ts';
import { mulberry32, weightedPick, type Rng } from './rng.ts';
import {
  MS_PER_DAY, MS_PER_MINUTE, dayBoundsUtcMs, dayKeyInZone,
  localTimeOnDayUtcMs, startOfNextDayUtcMs, toIso,
} from './time.ts';

/** A (business, group) pairing that survived every eligibility check. */
interface Candidate {
  businessId: Id;
  group: Group;
  /** Ads that fit this group's composer and are not inside their own cooldown. */
  eligibleAds: Ad[];
  /** When this group last received a post, as epoch ms. -Infinity if never. */
  lastPostedMs: number;
  /** Cooldown that applies to this group, in days. */
  cooldownDays: number;
}

/**
 * How many posts each business may place per day.
 *
 * `dailyCapShare` is a fraction of the global cap. When it is null the business
 * takes an even split; remainders go to the earliest businesses rather than
 * being lost, so the configured cap is actually reachable.
 */
function dailyLimits(businesses: Business[], dailyCap: number): Map<Id, number> {
  const limits = new Map<Id, number>();
  const unshared = businesses.filter((b) => b.dailyCapShare === null);
  const sharedTotal = businesses
    .filter((b) => b.dailyCapShare !== null)
    .reduce((sum, b) => sum + Math.round(dailyCap * (b.dailyCapShare ?? 0)), 0);

  for (const b of businesses) {
    if (b.dailyCapShare !== null) limits.set(b.id, Math.max(0, Math.round(dailyCap * b.dailyCapShare)));
  }

  const left = Math.max(0, dailyCap - sharedTotal);
  const base = unshared.length ? Math.floor(left / unshared.length) : 0;
  let remainder = unshared.length ? left - base * unshared.length : 0;
  for (const b of unshared) {
    limits.set(b.id, base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder--;
  }
  return limits;
}

export function createScheduler(store: Store): Scheduler {
  /**
   * Build the times at which posts may happen, day by day, honouring the
   * active-hours window and whatever is left of each day's cap after posts
   * already logged for that day.
   */
  function buildSlots(rng: Rng, nowMs: number, windowEndMs: number): { ms: number; dayKey: string }[] {
    const s = store.settings.get();
    const slots: { ms: number; dayKey: string }[] = [];
    const gap = () => rng.int(s.minGapMinutes, s.maxGapMinutes) * MS_PER_MINUTE;

    let dayCursor = nowMs;
    while (dayCursor < windowEndMs) {
      const dayKey = dayKeyInZone(dayCursor, s.timezone);
      const { start } = dayBoundsUtcMs(dayCursor, s.timezone);
      const nextDay = startOfNextDayUtcMs(dayCursor, s.timezone);

      const alreadyPosted = store.log.countPostedBetween(toIso(start), toIso(nextDay));
      const remaining = Math.max(0, s.dailyCap - alreadyPosted);

      const openMs = localTimeOnDayUtcMs(dayCursor, s.timezone, s.activeHourStart);
      const closeMs = localTimeOnDayUtcMs(dayCursor, s.timezone, s.activeHourEnd);

      // Start somewhere inside the first gap rather than exactly on the hour —
      // posting at 08:00:00 sharp every morning is itself a pattern.
      let t = Math.max(openMs, nowMs) + rng.int(0, s.maxGapMinutes) * MS_PER_MINUTE;
      let placed = 0;
      while (t < closeMs && t < windowEndMs && placed < remaining) {
        slots.push({ ms: t, dayKey });
        t += gap();
        placed++;
      }
      dayCursor = nextDay;
    }
    return slots;
  }

  /** Eligibility pass. Produces candidates plus a reason for every rejection. */
  function collectCandidates(nowMs: number): { candidates: Candidate[]; exclusions: PlanExclusion[] } {
    const s = store.settings.get();
    const exclusions: PlanExclusion[] = [];
    const candidates: Candidate[] = [];
    const businesses = store.businesses.list({ activeOnly: true });

    const assignedAnywhere = new Set(store.groups.allAssignments().map((a) => a.groupId));
    for (const g of store.groups.list({ activeOnly: true })) {
      if (!assignedAnywhere.has(g.id)) {
        // businessId 0 = "no business at all", since this is not a per-business fact.
        exclusions.push({ groupId: g.id, businessId: 0, reason: 'no-assignment' });
      }
    }

    for (const biz of businesses) {
      const ads = store.ads
        .list({ businessId: biz.id, activeOnly: true })
        // An ad with no active variants cannot be posted; treat it as absent.
        .filter((ad) => store.ads.variants(ad.id, { activeOnly: true }).length > 0);

      for (const groupId of store.groups.assignments(biz.id)) {
        const group = store.groups.get(groupId);
        if (!group) continue;
        const add = (reason: PlanExclusion['reason'], detail?: string) =>
          exclusions.push({ groupId, businessId: biz.id, reason, ...(detail ? { detail } : {}) });

        if (!group.active) { add('group-inactive'); continue; }

        if (group.quarantinedUntil && Date.parse(group.quarantinedUntil) > nowMs) {
          add('group-quarantined', group.quarantineReason ?? undefined);
          continue;
        }

        const cooldownDays = group.cooldownDaysOverride ?? s.perGroupCooldownDays;
        const last = store.log.lastPostToGroup(groupId);
        const lastPostedMs = last ? Date.parse(last.postedAt) : Number.NEGATIVE_INFINITY;
        if (last && nowMs - lastPostedMs < cooldownDays * MS_PER_DAY) {
          const daysLeft = ((cooldownDays * MS_PER_DAY - (nowMs - lastPostedMs)) / MS_PER_DAY).toFixed(1);
          add('cooldown', `${daysLeft}d remaining of ${cooldownDays}d`);
          continue;
        }

        // The composer differs between normal and marketplace groups, so an ad
        // built for one simply cannot be posted into the other.
        const fitting = ads.filter((ad) => ad.composerType === group.composerType);
        if (fitting.length === 0) {
          add('no-eligible-ad', `no active ${group.composerType} ad for this business`);
          continue;
        }

        const eligibleAds = fitting.filter((ad) => {
          const lastOfAd = store.log.lastPostOfAdToGroup(groupId, ad.id);
          if (!lastOfAd) return true;
          return nowMs - Date.parse(lastOfAd.postedAt) >= s.perGroupAdCooldownDays * MS_PER_DAY;
        });
        if (eligibleAds.length === 0) {
          add('ad-cooldown', `every fitting ad is inside its ${s.perGroupAdCooldownDays}d per-group cooldown`);
          continue;
        }

        candidates.push({ businessId: biz.id, group, eligibleAds, lastPostedMs, cooldownDays });
      }
    }
    return { candidates, exclusions };
  }

  function plan(opts: { now: string; windowEnd: string; seed?: number }): Plan {
    const s = store.settings.get();
    const nowMs = Date.parse(opts.now);
    const windowEndMs = Date.parse(opts.windowEnd);
    const rng = mulberry32(opts.seed ?? Math.floor(nowMs / MS_PER_MINUTE));

    const { candidates, exclusions } = collectCandidates(nowMs);
    const slots = buildSlots(rng, nowMs, windowEndMs);

    const businesses = store.businesses.list({ activeOnly: true });
    const limits = dailyLimits(businesses, s.dailyCap);

    const posts: PlannedPost[] = [];
    const perBizPerDay = new Map<string, number>();
    /** Group -> when it was last given a slot in THIS plan. */
    const plannedForGroup = new Map<Id, number>();
    const used = new Set<string>();
    let lastVariantId: Id | null = null;

    for (const slot of slots) {
      // Pick the eligible candidate that has gone longest without a post. That
      // fairness ordering is what stops the first few groups in the list
      // absorbing the whole daily cap forever.
      let best: Candidate | null = null;
      let bestLastMs = Number.POSITIVE_INFINITY;

      for (const c of candidates) {
        const dayKey = `${c.businessId}|${slot.dayKey}`;
        if ((perBizPerDay.get(dayKey) ?? 0) >= (limits.get(c.businessId) ?? 0)) continue;

        // A group already placed in this plan has to clear its cooldown again
        // relative to that placement, not just relative to its logged history.
        const plannedMs = plannedForGroup.get(c.group.id);
        const effectiveLastMs = Math.max(c.lastPostedMs, plannedMs ?? Number.NEGATIVE_INFINITY);
        if (effectiveLastMs !== Number.NEGATIVE_INFINITY
          && slot.ms - effectiveLastMs < c.cooldownDays * MS_PER_DAY) continue;

        if (effectiveLastMs < bestLastMs) { best = c; bestLastMs = effectiveLastMs; }
      }
      if (!best) continue;

      const ad = rng.pick(best.eligibleAds);
      if (!ad) continue;
      const variants = store.ads.variants(ad.id, { activeOnly: true });

      // Rotate variants, and actively avoid repeating the text of the post
      // immediately before this one — back-to-back identical captions across
      // different groups is the clearest automation tell there is.
      let variant = weightedPick(rng, variants, (v) => v.weight);
      if (variants.length > 1 && variant && variant.id === lastVariantId) {
        const alternatives = variants.filter((v) => v.id !== lastVariantId);
        variant = weightedPick(rng, alternatives, (v) => v.weight) ?? variant;
      }
      if (!variant) continue;

      posts.push({
        businessId: best.businessId,
        groupId: best.group.id,
        adId: ad.id,
        variantId: variant.id,
        scheduledFor: toIso(slot.ms),
      });

      const dayKey = `${best.businessId}|${slot.dayKey}`;
      perBizPerDay.set(dayKey, (perBizPerDay.get(dayKey) ?? 0) + 1);
      plannedForGroup.set(best.group.id, slot.ms);
      used.add(`${best.businessId}:${best.group.id}`);
      lastVariantId = variant.id;
    }

    // Anything eligible that never got a slot lost out to the cap, not to a rule.
    for (const c of candidates) {
      if (!used.has(`${c.businessId}:${c.group.id}`)) {
        exclusions.push({
          groupId: c.group.id,
          businessId: c.businessId,
          reason: 'daily-cap',
          detail: 'eligible, but the window ran out of slots',
        });
      }
    }

    return {
      generatedAt: toIso(nowMs),
      windowStart: opts.now,
      windowEnd: opts.windowEnd,
      posts,
      exclusions,
    };
  }

  function commit(p: Plan): QueueItem[] {
    const mode = store.settings.get().defaultRunnerMode;
    return store.queue.createMany(
      p.posts.map((post) => ({ ...post, status: 'pending' as const, runnerMode: mode, roundId: null })),
    );
  }

  return { plan, commit };
}
