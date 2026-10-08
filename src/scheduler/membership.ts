/**
 * "May this business's identity post in this group right now?" — the
 * membership half of eligibility, shared by the drip planner, the round
 * builder and the run loop so all three give the same answer.
 *
 * The group-level checks (active, group quarantine, composer, cooldowns) stay
 * where they were. This only adds what identities introduced: the identity has
 * to be a member, and a group may have refused that identity specifically.
 */
import type { PlanExclusion, Store } from '../domain/contracts.ts';
import type { Id, Identity } from '../domain/types.ts';

export interface MembershipBlock {
  reason: Extract<PlanExclusion['reason'], 'not-a-member' | 'group-quarantined'>;
  detail: string;
}

export function membershipBlock(
  store: Store, groupId: Id, identity: Identity, nowMs: number,
): MembershipBlock | null {
  const m = store.memberships.get(groupId, identity.id);
  if (!m) {
    return { reason: 'not-a-member', detail: `${identity.name} has not joined this group` };
  }
  if (!m.active) {
    return {
      reason: 'not-a-member',
      detail: `${identity.name} was not found in this group on the last import`,
    };
  }
  if (m.quarantinedUntil && Date.parse(m.quarantinedUntil) > nowMs) {
    return {
      reason: 'group-quarantined',
      detail: `for ${identity.name}: ${m.quarantineReason ?? 'no reason recorded'}`,
    };
  }
  return null;
}
