/**
 * What happens next, and when.
 *
 * Pure: given the leads, the settings and today's action counts, produce the
 * ordered list of follows and DMs a run would do from `now` until the end of
 * today's active hours, the caps, or the work runs out. Nothing here touches
 * a browser or a database, and it is seeded, so the dry run you inspect is
 * the plan that runs.
 *
 * The run loop takes the first step, does it, and asks again — the plan is
 * recomputed after every action, because each one changes the state (a
 * follow-back noticed, a lead filtered out, a block).
 *
 * DM timing, per lead:
 *   on follow       dmDueAt = followedAt + random(dmDelayMinHours..dmDelayMaxHours)
 *   on follow-back  dmDueAt = min(dmDueAt, followedBackAt + random(followBackDm*Minutes))
 * So a DM goes out 24–48h after the follow regardless, or sooner once they
 * follow back. Both helpers live here so the rule is in one place.
 */
import type { IgCampaign, IgLead, IgMessageVariant, IgSettings, Id } from '../domain/types.ts';
import { mulberry32, weightedPick, type Rng } from '../../core/rng.ts';
import { dayBoundsUtcMs, localHour, localTimeOnDayUtcMs, MS_PER_MINUTE, toIso } from '../../core/time.ts';

export function dmDueAfterFollow(followedAtMs: number, c: Pick<IgCampaign, 'dmDelayMinHours' | 'dmDelayMaxHours'>, rng: Rng): number {
  const lo = Math.min(c.dmDelayMinHours, c.dmDelayMaxHours) * 60;
  const hi = Math.max(c.dmDelayMinHours, c.dmDelayMaxHours) * 60;
  return followedAtMs + rng.int(lo, hi) * MS_PER_MINUTE;
}

export function dmDueAfterFollowBack(
  currentDueMs: number | null,
  followedBackAtMs: number,
  s: Pick<IgSettings, 'followBackDmMinMinutes' | 'followBackDmMaxMinutes'>,
  rng: Rng,
): number {
  const lo = Math.min(s.followBackDmMinMinutes, s.followBackDmMaxMinutes);
  const hi = Math.max(s.followBackDmMinMinutes, s.followBackDmMaxMinutes);
  const soon = followedBackAtMs + rng.int(lo, hi) * MS_PER_MINUTE;
  return currentDueMs === null ? soon : Math.min(currentDueMs, soon);
}

export type PlannedStep =
  | { kind: 'follow'; at: string; leadId: Id; username: string; campaignId: Id }
  | { kind: 'dm'; at: string; leadId: Id; username: string; campaignId: Id; variantId: Id };

export interface PlanInput {
  now: string;
  settings: IgSettings;
  campaigns: IgCampaign[];
  /** Leads in status `new` or `followed`; others are ignored. */
  leads: IgLead[];
  variants: IgMessageVariant[];
  /** Actions that already reached Instagram today (store.actions.countBetween). */
  doneToday: { follow: number; dm: number; profileVisit: number };
  lastDmVariantId: Id | null;
  seed?: number;
}

export interface Plan {
  steps: PlannedStep[];
  /** Why the plan stops where it does, or why it is empty. */
  stopReason: string;
  /** Things worth fixing: e.g. a campaign with followed leads but no message. */
  warnings: string[];
  remaining: { follows: number; dms: number };
}

export function plan(input: PlanInput): Plan {
  const s = input.settings;
  const rng = mulberry32(input.seed ?? Date.parse(input.now));
  const nowMs = Date.parse(input.now);
  const warnings: string[] = [];

  let follows = Math.max(0, Math.min(
    s.dailyFollowCap - input.doneToday.follow,
    // Each follow costs a profile visit (the filters run on the profile).
    s.dailyProfileVisitCap - input.doneToday.profileVisit,
  ));
  let dms = Math.max(0, s.dailyDmCap - input.doneToday.dm);
  const result = (steps: PlannedStep[], stopReason: string): Plan =>
    ({ steps, stopReason, warnings, remaining: { follows, dms } });

  if (s.breakerTripped) return result([], `breaker tripped: ${s.breakerReason ?? 'no reason recorded'}`);

  const day = dayBoundsUtcMs(nowMs, s.timezone);
  const windowStart = localTimeOnDayUtcMs(nowMs, s.timezone, s.activeHourStart);
  const windowEnd = s.activeHourEnd >= 24 ? day.end : localTimeOnDayUtcMs(nowMs, s.timezone, s.activeHourEnd);
  const hour = localHour(nowMs, s.timezone);
  if (hour < s.activeHourStart || hour >= s.activeHourEnd) {
    return result([], `outside active hours (${pad(s.activeHourStart)}:00–${pad(s.activeHourEnd)}:00)`);
  }

  const active = new Map(input.campaigns.filter((c) => c.active).map((c) => [c.id, c]));
  const variantsOf = new Map<Id, IgMessageVariant[]>();
  for (const v of input.variants) {
    if (!v.active || !active.has(v.campaignId)) continue;
    variantsOf.set(v.campaignId, [...(variantsOf.get(v.campaignId) ?? []), v]);
  }

  const usable = (l: IgLead) => active.has(l.campaignId) && l.attempts < s.maxAttempts;

  // Follow queue: round-robin across campaigns, oldest harvested first within
  // each, so one big campaign cannot starve the others.
  const byCampaign = new Map<Id, IgLead[]>();
  for (const l of input.leads) {
    if (l.status !== 'new' || !usable(l)) continue;
    byCampaign.set(l.campaignId, [...(byCampaign.get(l.campaignId) ?? []), l]);
  }
  for (const list of byCampaign.values()) list.sort(byHarvest);
  const followQueue: IgLead[] = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const id of [...byCampaign.keys()].sort((a, b) => a - b)) {
      const l = byCampaign.get(id)![i];
      if (l) { followQueue.push(l); any = true; }
    }
    if (!any) break;
  }

  // DM queue, by due time. Campaigns with no active message are reported, not
  // silently stalled.
  const silent = new Set<Id>();
  const dmQueue = input.leads
    .filter((l) => l.status === 'followed' && l.dmDueAt !== null && usable(l))
    .filter((l) => {
      if (variantsOf.has(l.campaignId)) return true;
      silent.add(l.campaignId);
      return false;
    })
    .sort((a, b) => Date.parse(a.dmDueAt!) - Date.parse(b.dmDueAt!) || a.id - b.id);
  for (const id of silent) {
    warnings.push(`campaign "${active.get(id)!.name}" has followed leads but no active message — its DMs are on hold`);
  }

  const steps: PlannedStep[] = [];
  let lastVariant = input.lastDmVariantId;
  let lastKind: PlannedStep['kind'] | null = null;
  let t = Math.max(nowMs, windowStart);

  while (true) {
    if (t >= windowEnd) return result(steps, 'end of active hours');

    const dueDm = dms > 0 ? dmQueue.find((l) => Date.parse(l.dmDueAt!) <= t) : undefined;
    const nextFollow = follows > 0 ? followQueue[0] : undefined;

    // Alternate when both kinds are ready: twelve DMs back to back is a
    // pattern; a mix of follows and messages looks like a person.
    let pick: 'dm' | 'follow' | null = null;
    if (dueDm && nextFollow) pick = lastKind === 'dm' ? 'follow' : 'dm';
    else if (dueDm) pick = 'dm';
    else if (nextFollow) pick = 'follow';

    if (pick === null) {
      if (dms > 0) {
        // Nothing ready now, but a DM may come due later today: wait for it.
        const later = dmQueue.map((l) => Date.parse(l.dmDueAt!)).filter((ms) => ms > t && ms < windowEnd);
        if (later.length > 0) { t = Math.min(...later); continue; }
      }
      if (follows === 0 && dms === 0) return result(steps, 'daily caps reached');
      if (follows === 0 && followQueue.length > 0) return result(steps, 'daily follow cap reached');
      if (dms === 0 && dmQueue.length > 0) return result(steps, 'daily DM cap reached');
      return result(steps, steps.length === 0 ? 'nothing to do — harvest more leads' : 'no more work today');
    }

    if (pick === 'dm') {
      const lead = dueDm!;
      dmQueue.splice(dmQueue.indexOf(lead), 1);
      const options = variantsOf.get(lead.campaignId)!;
      // No back-to-back repeats when there is any alternative.
      const fresh = options.length > 1 ? options.filter((v) => v.id !== lastVariant) : options;
      const variant = weightedPick(rng, fresh, (v) => v.weight)!;
      lastVariant = variant.id;
      steps.push({ kind: 'dm', at: toIso(t), leadId: lead.id, username: lead.username, campaignId: lead.campaignId, variantId: variant.id });
      dms--;
    } else {
      const lead = followQueue.shift()!;
      steps.push({ kind: 'follow', at: toIso(t), leadId: lead.id, username: lead.username, campaignId: lead.campaignId });
      follows--;
    }
    lastKind = pick;
    t += rng.int(Math.min(s.minGapMinutes, s.maxGapMinutes), Math.max(s.minGapMinutes, s.maxGapMinutes)) * MS_PER_MINUTE;
  }
}

const byHarvest = (a: IgLead, b: IgLead) => a.harvestedAt.localeCompare(b.harvestedAt) || a.id - b.id;
const pad = (n: number) => String(n).padStart(2, '0');
