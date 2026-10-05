/**
 * Dry run. Builds the schedule and prints it. Persists nothing unless --commit
 * is passed, and even then it says exactly what it wrote.
 */
import { openApp } from './deps.ts';

const args = new Set(process.argv.slice(2));
const commit = args.has('--commit');
const days = Number([...args].find((a) => a.startsWith('--days='))?.split('=')[1] ?? '7');

const { store, scheduler } = openApp();
const now = new Date();
const windowEnd = new Date(now.getTime() + days * 86_400_000);

const plan = scheduler.plan({ now: now.toISOString(), windowEnd: windowEnd.toISOString() });

const nameOfGroup = (id: number) => store.groups.get(id)?.name ?? `group#${id}`;
const nameOfBiz = (id: number) => store.businesses.get(id)?.name ?? `business#${id}`;
const nameOfAd = (id: number) => store.ads.get(id)?.name ?? `ad#${id}`;

console.log(`\nPlan for the next ${days} day(s) — ${plan.posts.length} post(s)\n`);
for (const p of plan.posts) {
  const when = new Date(p.scheduledFor).toLocaleString();
  console.log(`  ${when}  ${nameOfBiz(p.businessId).padEnd(16)} ${nameOfAd(p.adId).padEnd(20)} v${p.variantId}  →  ${nameOfGroup(p.groupId)}`);
}

if (plan.exclusions.length) {
  const byReason = new Map<string, number>();
  for (const e of plan.exclusions) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  console.log('\nExcluded:');
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }
  console.log('\n  (full detail per group is in the Plan screen of the UI)');
}

if (commit) {
  const items = scheduler.commit(plan);
  console.log(`\nCommitted ${items.length} item(s) to the queue.`);
} else {
  console.log('\nDry run — nothing was queued. Re-run with --commit to schedule this.');
}
store.close();
