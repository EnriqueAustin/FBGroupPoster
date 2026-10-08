/**
 * Lead state transitions. Every change to a lead's status goes through here,
 * paired with the action-log row that the daily caps are counted from — so a
 * follow can never be recorded on the lead without also counting against the
 * cap, or vice versa.
 */
import type { IgStore } from '../domain/contracts.ts';
import type { Id, IgActionKind, IgActionOutcome, IgLead, IsoDateTime } from '../domain/types.ts';
import { mulberry32, type Rng } from '../../core/rng.ts';
import { toIso } from '../../core/time.ts';
import { dmDueAfterFollow, dmDueAfterFollowBack } from './planner.ts';

const rngFor = (at: IsoDateTime, leadId: Id): Rng => mulberry32(Date.parse(at) ^ (leadId * 2654435761));

function mustLead(store: IgStore, leadId: Id): IgLead {
  const lead = store.leads.get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  return lead;
}

function log(store: IgStore, lead: IgLead, kind: 'follow' | 'dm' | 'profile_visit' | 'check',
  outcome: IgActionOutcome, at: IsoDateTime, detail: string | null = null): void {
  store.actions.record({ kind, outcome, leadId: lead.id, campaignId: lead.campaignId, at, detail });
}

/** Profile visited and a filter said no. Costs a visit, never a follow. */
export function markSkipped(store: IgStore, leadId: Id, reason: string, at: IsoDateTime): IgLead {
  const lead = mustLead(store, leadId);
  log(store, lead, 'profile_visit', 'ok', at, `skipped: ${reason}`);
  return store.leads.update(leadId, { status: 'skipped', skipReason: reason });
}

/**
 * Followed (or found already followed). Schedules the DM 24–48h out; if they
 * already follow us, it comes forward straight away.
 */
export function markFollowed(
  store: IgStore, leadId: Id, at: IsoDateTime,
  opts: { followsUs?: boolean; alreadyFollowing?: boolean; rng?: Rng } = {},
): IgLead {
  const lead = mustLead(store, leadId);
  const campaign = store.campaigns.get(lead.campaignId);
  if (!campaign) throw new Error(`campaign ${lead.campaignId} not found`);
  const rng = opts.rng ?? rngFor(at, leadId);
  const atMs = Date.parse(at);

  log(store, lead, 'profile_visit', 'ok', at);
  // Already following by hand: no click reached Instagram, so no cap is spent.
  log(store, lead, 'follow', opts.alreadyFollowing ? 'skipped' : 'ok', at,
    opts.alreadyFollowing ? 'already following' : null);

  let due = dmDueAfterFollow(atMs, campaign, rng);
  if (opts.followsUs) due = dmDueAfterFollowBack(due, atMs, store.settings.get(), rng);

  return store.leads.update(leadId, {
    status: 'followed',
    followedAt: at,
    followedBackAt: opts.followsUs ? at : null,
    dmDueAt: toIso(due),
    lastError: null,
  });
}

/** A follow-back noticed on a later check: pull the DM forward. */
export function markFollowedBack(store: IgStore, leadId: Id, at: IsoDateTime, rng?: Rng): IgLead {
  const lead = mustLead(store, leadId);
  if (lead.status !== 'followed' || lead.followedBackAt) return lead;
  const due = dmDueAfterFollowBack(
    lead.dmDueAt ? Date.parse(lead.dmDueAt) : null, Date.parse(at), store.settings.get(), rng ?? rngFor(at, leadId),
  );
  return store.leads.update(leadId, { followedBackAt: at, dmDueAt: toIso(due) });
}

export function markMessaged(store: IgStore, leadId: Id, variantId: Id, at: IsoDateTime): IgLead {
  const lead = mustLead(store, leadId);
  log(store, lead, 'dm', 'ok', at, `variant ${variantId}`);
  return store.leads.update(leadId, { status: 'messaged', messagedAt: at, variantId, lastError: null });
}

/** They answered. The sequence stops; a human takes it from here. */
export function markReplied(store: IgStore, leadId: Id, at: IsoDateTime): IgLead {
  mustLead(store, leadId);
  return store.leads.update(leadId, { status: 'replied', repliedAt: at });
}

/** Never contact again. Allowed from any status — a human decision always wins. */
export function markOptedOut(store: IgStore, leadId: Id, reason = 'opted out'): IgLead {
  mustLead(store, leadId);
  return store.leads.update(leadId, { status: 'opted_out', skipReason: reason });
}

/**
 * An action that reached Instagram but could not be confirmed. Counts against
 * the cap (it clicked), bumps attempts, and gives up on the lead after
 * `maxAttempts` so one broken profile cannot eat the day.
 */
export function markFailed(
  store: IgStore, leadId: Id, kind: 'follow' | 'dm', error: string, at: IsoDateTime,
): IgLead {
  const lead = mustLead(store, leadId);
  log(store, lead, kind, 'failed', at, error);
  const attempts = lead.attempts + 1;
  const giveUp = attempts >= store.settings.get().maxAttempts;
  return store.leads.update(leadId, {
    attempts,
    lastError: error,
    ...(giveUp ? { status: 'failed' as const } : {}),
  });
}

/**
 * Instagram pushed back (action blocked, challenge, "try again later").
 * Logged against the lead, and the breaker trips: nothing else runs until a
 * human has looked. The lead itself is not penalised — it was not its fault.
 */
export function markBlocked(
  store: IgStore, leadId: Id | null, kind: IgActionKind,
  reason: string, at: IsoDateTime,
): void {
  const lead = leadId === null ? null : mustLead(store, leadId);
  store.actions.record({
    kind, outcome: 'blocked', leadId: lead?.id ?? null, campaignId: lead?.campaignId ?? null, at, detail: reason,
  });
  store.settings.tripBreaker(reason, at);
}
