/**
 * Works through whatever is due. Assisted by default: the browser opens, the
 * post is composed for you, and you click Post yourself.
 */
import { openApp } from './deps.ts';
import { createRunner } from '../runner/playwright-runner.ts';
import { createOrchestrator } from '../orchestrator.ts';

const args = new Set(process.argv.slice(2));
const maxPosts = Number([...args].find((a) => a.startsWith('--max='))?.split('=')[1] ?? '15');

const { store } = openApp();
const runner = createRunner({});
const orchestrator = createOrchestrator({ store, runner });

process.on('SIGINT', () => {
  console.log('\nStopping after the current post…');
  orchestrator.stop();
});

const summary = await orchestrator.runDue(maxPosts);
console.log(`\nposted ${summary.posted} · skipped ${summary.skipped} · failed ${summary.failed} · blocked ${summary.blocked}`);
console.log(`stopped because: ${summary.stoppedBecause}`);
store.close();
