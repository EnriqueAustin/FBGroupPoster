/**
 * One-time import of the groups you already belong to. Safe to re-run; groups
 * are upserted by their Facebook id, so your curation is never overwritten.
 *
 *   npm run bootstrap              your personal profile's groups
 *   npm run bootstrap -- --as=2    the groups identity 2 (a Page) has joined
 *
 * The same thing is available as a button in the UI (Setup tab).
 */
import { openApp } from './deps.ts';
import { createGroupDiscoverer } from '../runner/discover-groups.ts';
import { importGroups } from '../bootstrap.ts';

const asArg = process.argv.slice(2).find((a) => a.startsWith('--as='))?.split('=')[1];

const { store } = openApp();
const identity = asArg === undefined ? store.identities.profile() : store.identities.get(Number(asArg));
if (!identity) {
  console.error(`No identity ${asArg}. Known: ${store.identities.list().map((i) => `${i.id} = ${i.name}`).join(', ')}`);
  store.close();
  process.exit(1);
}

const discoverer = createGroupDiscoverer({
  identity,
  onLearnedFbPageId: (fbPageId) => store.identities.update(identity.id, { fbPageId }),
});

await importGroups(store, discoverer, (m) => console.log(m), identity.id);
store.close();
