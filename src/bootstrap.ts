/**
 * Importing your joined groups into the registry.
 *
 * Shared by the CLI and the server so both behave identically — in particular
 * both preserve curation on re-import, which is the whole reason this is not
 * just an INSERT loop.
 */
import type { GroupDiscoverer, Store } from './domain/contracts.ts';

export interface ImportResult {
  found: number;
  created: number;
  updated: number;
}

export async function importGroups(
  store: Store,
  discoverer: GroupDiscoverer,
  log: (msg: string) => void = () => {},
): Promise<ImportResult> {
  const found = await discoverer.discover();
  log(`Found ${found.length} group(s).`);

  let created = 0;
  let updated = 0;

  for (const g of found) {
    const existing = store.groups.getByFbId(g.fbGroupId);
    const res = store.groups.upsertByFbId({
      fbGroupId: g.fbGroupId,
      name: g.name,
      url: g.url,
      memberCount: g.memberCount,
      // Every field below falls back to what is already stored. Re-running the
      // import refreshes names and member counts without undoing an evening's
      // worth of curation.
      composerType: existing?.composerType ?? g.composerTypeGuess,
      // New groups arrive switched off. With ~100 groups, opt-out would be an
      // unrecoverable mistake the first time you commit a plan.
      active: existing?.active ?? false,
      cooldownDaysOverride: existing?.cooldownDaysOverride ?? null,
      rulesNotes: existing?.rulesNotes ?? '',
      quarantinedUntil: existing?.quarantinedUntil ?? null,
      quarantineReason: existing?.quarantineReason ?? null,
      tags: existing?.tags ?? [],
    });
    if (res.created) created++; else updated++;
  }

  log(`${created} new, ${updated} updated.`);
  if (created > 0) {
    log('New groups are INACTIVE. Switch on the ones you want in the Groups tab.');
  }
  return { found: found.length, created, updated };
}
