/**
 * One-time import of the groups you already belong to. Safe to re-run; groups
 * are upserted by their Facebook id, so your curation is never overwritten.
 *
 * The same thing is available as a button in the UI (Setup tab).
 */
import { openApp } from './deps.ts';
import { createGroupDiscoverer } from '../runner/discover-groups.ts';
import { importGroups } from '../bootstrap.ts';

const { store } = openApp();
const discoverer = createGroupDiscoverer({});

await importGroups(store, discoverer, (m) => console.log(m));
store.close();
