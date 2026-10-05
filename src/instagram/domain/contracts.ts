/**
 * Interfaces that decouple the IG module's parts. The planner knows nothing
 * about SQLite; the runner will know nothing about the planner.
 */
import type {
  Id, IgAction, IgActionKind, IgCampaign, IgLead, IgMessageVariant, IgSettings,
  IsoDateTime, LeadSource, LeadStatus,
} from './types.ts';

export type NewIgCampaign = Omit<IgCampaign, 'id' | 'createdAt'>;
export type NewIgVariant = Omit<IgMessageVariant, 'id' | 'createdAt'>;
export type NewIgAction = Omit<IgAction, 'id'>;

/** What the harvester hands over for one person found on a source post. */
export interface HarvestedLead {
  username: string;
  displayName: string | null;
  source: LeadSource;
  sourceHandle: string;
  sourcePostUrl: string | null;
}

/** Fields the run loop may change on a lead as it moves through its life. */
export type LeadPatch = Partial<Pick<IgLead,
  | 'displayName' | 'status' | 'skipReason' | 'followedAt' | 'followedBackAt' | 'dmDueAt'
  | 'messagedAt' | 'variantId' | 'repliedAt' | 'attempts' | 'lastError'>>;

export interface IgStore {
  campaigns: {
    list(opts?: { activeOnly?: boolean }): IgCampaign[];
    get(id: Id): IgCampaign | null;
    create(c: NewIgCampaign): IgCampaign;
    update(id: Id, patch: Partial<NewIgCampaign>): IgCampaign;
    /** Refuses once any lead references it: leads are the contacted registry. */
    remove(id: Id): void;
  };

  variants: {
    list(opts?: { campaignId?: Id; activeOnly?: boolean }): IgMessageVariant[];
    get(id: Id): IgMessageVariant | null;
    create(v: NewIgVariant): IgMessageVariant;
    update(id: Id, patch: Partial<NewIgVariant>): IgMessageVariant;
    remove(id: Id): void;
  };

  leads: {
    list(opts?: { campaignId?: Id; status?: LeadStatus | LeadStatus[]; limit?: number }): IgLead[];
    get(id: Id): IgLead | null;
    getByUsername(username: string): IgLead | null;
    /**
     * Insert harvested people as `new` leads. Anyone already known — in ANY
     * campaign, in ANY status — is left untouched and counted as a duplicate.
     */
    addHarvested(campaignId: Id, people: HarvestedLead[], at: IsoDateTime): { added: IgLead[]; duplicates: number };
    update(id: Id, patch: LeadPatch): IgLead;
    countByStatus(campaignId?: Id): Record<LeadStatus, number>;
    /** Every username ever seen, for the harvester's cheap pre-filter. */
    hasUsername(username: string): boolean;
  };

  actions: {
    record(a: NewIgAction): IgAction;
    list(opts?: { limit?: number; leadId?: Id }): IgAction[];
    /**
     * Actions of one kind in [from, to) that reached Instagram — `ok`,
     * `failed` and `blocked`. A failed follow still clicked the button, so it
     * counts against the cap; a `skipped` one did not.
     */
    countBetween(kind: IgActionKind, from: IsoDateTime, to: IsoDateTime): number;
    /** The variant used by the most recent DM, to avoid back-to-back repeats. */
    lastDmVariantId(): Id | null;
  };

  settings: {
    get(): IgSettings;
    update(patch: Partial<IgSettings>): IgSettings;
    tripBreaker(reason: string, at: IsoDateTime): IgSettings;
    clearBreaker(): IgSettings;
  };

  close(): void;
}
