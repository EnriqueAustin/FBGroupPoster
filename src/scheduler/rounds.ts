/**
 * Round posting — the campaign path.
 *
 * The drip planner in planner.ts answers "which groups may hear from us today,
 * given that a group must not hear from us more than once a week?". A round
 * answers a different question: "put THIS ad in front of EVERY group I selected,
 * now, and let me do that again in a few hours."
 *
 * That is deliberately the thing planner.ts refuses to do, so this module does
 * not soften those rules — it replaces them with tighter, hour-scale ones:
 *
 *   roundsPerDay           how many rounds one group may receive in a local day
 *   minHoursBetweenRounds  how long that group then rests
 *   roundDailyCap          ceiling on round posts per day across all groups
 *   round gap minutes      spacing between consecutive posts inside one round
 *
 * Everything else still applies: inactive and quarantined groups are skipped,
 * the composer type must match, the circuit breaker still stops the run, and
 * variants still rotate so twenty groups do not receive identical text.
 *
 * Like plan(), planRound() is pure: it reads the store and returns a Plan.
 */
import type { Plan, PlanExclusion, PlannedPost, Store } from '../domain/contracts.ts';
import type { AdVariant, Id, QueueItem } from '../domain/types.ts';
import { mulberry32, weightedPick } from './rng.ts';
import { dayBoundsUtcMs, localHour, MS_PER_MINUTE, toIso } from './time.ts';

const MS_PER_HOUR = 3_600_000;

export interface RoundOptions {
  businessId: Id;
  /** Which ad to send round. Omit to use the business's first active ad. */
  adId?: Id;
  now: string;
  seed?: number;
}

export interface RoundPlan extends Plan {
  roundId: string;
  adId: Id;
  /** Set when the round runs outside active hours — advisory, not a refusal. */
  warning: string | null;
}

/** Readable in the queue, and unique per minute. */
function makeRoundId(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return `round-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

export function planRound(store: Store, opts: RoundOptions): RoundPlan {
  const s = store.settings.get();
  const nowMs = Date.parse(opts.now);
  const rng = mulberry32(opts.seed ?? Math.floor(nowMs / MS_PER_MINUTE));
  const roundId = makeRoundId(nowMs);

  const business = store.businesses.get(opts.businessId);
  if (!business) throw new Error(`business ${opts.businessId} not found`);

  // --- pick the ad -----------------------------------------------------------
  const ads = store.ads
    .list({ businessId: business.id, activeOnly: true })
    .filter((a) => store.ads.variants(a.id, { activeOnly: true }).length > 0);

  const ad = opts.adId === undefined ? ads[0] : ads.find((a) => a.id === opts.adId);
  if (!ad) {
    throw new Error(opts.adId === undefined
      ? `${business.name} has no active ad with at least one active variant`
      : `ad ${opts.adId} is not an active ad of ${business.name}, or has no active variants`);
  }

  const variants = store.ads.variants(ad.id, { activeOnly: true });

  // --- the local day, for every per-day counter ------------------------------
  const { start: dayStart, end: dayEnd } = dayBoundsUtcMs(nowMs, s.timezone);
  const dayFrom = toIso(dayStart);
  const dayTo = toIso(dayEnd);

  const roundPostsToday = store.log.countRoundPostsBetween(dayFrom, dayTo);
  const capLeft = s.roundDailyCap === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, s.roundDailyCap - roundPostsToday);

  // --- eligibility -----------------------------------------------------------
  const exclusions: PlanExclusion[] = [];
  const eligible: Id[] = [];

  for (const groupId of store.groups.assignments(business.id)) {
    const group = store.groups.get(groupId);
    if (!group) continue;
    const add = (reason: PlanExclusion['reason'], detail?: string) =>
      exclusions.push({ groupId, businessId: business.id, reason, ...(detail ? { detail } : {}) });

    if (!group.active) { add('group-inactive'); continue; }
    if (group.quarantinedUntil && Date.parse(group.quarantinedUntil) > nowMs) {
      add('group-quarantined', group.quarantineReason ?? undefined);
      continue;
    }
    if (group.composerType !== ad.composerType) {
      add('no-eligible-ad', `this group needs a ${group.composerType} ad; "${ad.name}" is ${ad.composerType}`);
      continue;
    }

    // The two guards that stand in for the day-scale cooldowns.
    const history = store.log.roundHistoryForGroup(groupId, dayFrom, dayTo);
    if (history.count >= s.roundsPerDay) {
      add('rounds-today', `already had ${history.count} of ${s.roundsPerDay} rounds today`);
      continue;
    }
    if (history.lastPostedAt) {
      const sinceMs = nowMs - Date.parse(history.lastPostedAt);
      if (sinceMs < s.minHoursBetweenRounds * MS_PER_HOUR) {
        const left = ((s.minHoursBetweenRounds * MS_PER_HOUR - sinceMs) / MS_PER_HOUR).toFixed(1);
        add('round-too-soon', `${left}h left of the ${s.minHoursBetweenRounds}h rest between rounds`);
        continue;
      }
    }

    eligible.push(groupId);
  }

  // Shuffle. Walking the same 20 groups in the same order every round is itself
  // a signature, and it is free to avoid.
  for (let i = eligible.length - 1; i > 0; i--) {
    const k = rng.int(0, i);
    const tmp = eligible[i]!;
    eligible[i] = eligible[k]!;
    eligible[k] = tmp;
  }

  // --- place them, spaced by the round gap -----------------------------------
  const posts: PlannedPost[] = [];
  let cursor = nowMs;
  let lastVariantId: Id | null = null;

  for (const groupId of eligible) {
    if (posts.length >= capLeft) {
      exclusions.push({
        groupId,
        businessId: business.id,
        reason: 'round-daily-cap',
        detail: `the ${s.roundDailyCap}/day round cap is used up (${roundPostsToday} posted today)`,
      });
      continue;
    }

    // Rotate, and never repeat the previous caption back-to-back.
    let variant: AdVariant | undefined = weightedPick(rng, variants, (v) => v.weight);
    if (variants.length > 1 && variant && variant.id === lastVariantId) {
      variant = weightedPick(rng, variants.filter((v) => v.id !== lastVariantId), (v) => v.weight) ?? variant;
    }
    if (!variant) continue;

    posts.push({
      businessId: business.id,
      groupId,
      adId: ad.id,
      variantId: variant.id,
      scheduledFor: toIso(cursor),
      roundId,
    });
    lastVariantId = variant.id;
    cursor += rng.int(s.roundMinGapMinutes, s.roundMaxGapMinutes) * MS_PER_MINUTE;
  }

  // Active hours are advisory here rather than a refusal: a round is something
  // you trigger by hand, and refusing at 21:05 would just be obstructive.
  // Saying so is still worth it — 03:00 is a pattern nothing else disguises.
  const hour = localHour(nowMs, s.timezone);
  const warning = hour < s.activeHourStart || hour >= s.activeHourEnd
    ? `It is ${hour}:00 locally, outside your active hours `
      + `(${s.activeHourStart}:00–${s.activeHourEnd}:00). Posting now stands out more than posting during the day.`
    : null;

  return {
    roundId,
    adId: ad.id,
    generatedAt: toIso(nowMs),
    windowStart: opts.now,
    windowEnd: toIso(cursor),
    posts,
    exclusions,
    warning,
  };
}

/**
 * Persist a round to the queue.
 *
 * The runner mode is read here and again at run time, so a round committed
 * while assisted and run after switching to auto posts by itself, which is
 * what "I turned auto on" is supposed to mean.
 */
export function commitRound(store: Store, plan: RoundPlan): QueueItem[] {
  const mode = store.settings.get().defaultRunnerMode;
  return store.queue.createMany(plan.posts.map((p) => ({
    businessId: p.businessId,
    groupId: p.groupId,
    adId: p.adId,
    variantId: p.variantId,
    scheduledFor: p.scheduledFor,
    status: 'pending' as const,
    runnerMode: mode,
    roundId: plan.roundId,
  })));
}
