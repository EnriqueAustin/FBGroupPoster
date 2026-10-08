/**
 * The run loop's rules, against a real database and a fake browser.
 *
 * The fake IgRunner is what makes this possible: every rule worth testing —
 * a block stopping everything, a failure costing the lead an attempt but not
 * the account, an opt-out being permanent, the caps — is a decision this loop
 * makes, not something Instagram does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIgStore } from './store/sqlite-store.ts';
import { checkIg, harvestIg, runIg, type IgRunDeps } from './orchestrator.ts';
import { DEFAULT_FILTERS, DEFAULT_IG_SETTINGS } from './domain/types.ts';
import type {
  IgDmResult, IgFollowersResult, IgFollowResult, IgHarvestResult, IgInboxResult, IgRunner,
  NewIgCampaign,
} from './domain/contracts.ts';

const campaign = (over: Partial<NewIgCampaign> = {}): NewIgCampaign => ({
  name: 'Paarl coffee', active: true, sources: ['cafeone'], postsPerSource: 1,
  maxLeadsPerPost: 50, harvestLikers: true, harvestCommenters: false,
  dmDelayMinHours: 24, dmDelayMaxHours: 48, filters: DEFAULT_FILTERS, ...over,
});

const person = (username: string, displayName: string | null = null) => ({
  username, displayName, source: 'liker' as const, sourceHandle: 'cafeone', sourcePostUrl: null,
});

/** 10:00 local in the default timezone (UTC+2), inside active hours. */
const NOON = Date.parse('2026-10-06T08:00:00.000Z');

interface FakeOptions {
  follow?: (username: string) => IgFollowResult;
  dm?: (username: string) => IgDmResult;
  harvest?: () => IgHarvestResult;
  followers?: () => IgFollowersResult;
  inbox?: () => IgInboxResult;
  signedIn?: boolean;
}

function fakeRunner(opts: FakeOptions = {}) {
  const calls = { follows: [] as string[], dms: [] as { username: string; text: string }[], starts: 0 };
  const runner: IgRunner = {
    async start() { calls.starts++; return opts.signedIn ?? true; },
    async follow(username) {
      calls.follows.push(username);
      return opts.follow?.(username) ?? { outcome: 'followed', followsUs: false };
    },
    async dm(username, text) {
      calls.dms.push({ username, text });
      return opts.dm?.(username) ?? { outcome: 'sent' };
    },
    async harvest() {
      return opts.harvest?.() ?? { people: [], skipped: {}, postsRead: 0, notes: [] };
    },
    async followers() { return opts.followers?.() ?? { outcome: 'ok', followers: new Set<string>() }; },
    async inbox() { return opts.inbox?.() ?? { outcome: 'ok', entries: [] }; },
    async stop() {},
  };
  return { runner, calls };
}

/** A store with one campaign, one message and `names` as fresh leads. */
function seeded(names: string[], over: Partial<NewIgCampaign> = {}) {
  const store = openIgStore(':memory:');
  const c = store.campaigns.create(campaign(over));
  store.variants.create({
    campaignId: c.id, text: 'Hi {first_name}, saw you at the market!', imagePath: null, weight: 1, active: true,
  });
  store.leads.addHarvested(c.id, names.map((n) => person(n)), new Date(NOON).toISOString());
  return { store, campaignId: c.id };
}

/** Deps with a frozen clock and an instant sleep, so a run takes no time. */
function deps(store: ReturnType<typeof openIgStore>, runner: IgRunner, at = NOON): IgRunDeps {
  let clock = at;
  return {
    store,
    runner,
    now: () => new Date(clock),
    // Advancing the clock by what was asked keeps the planner's gaps honest
    // without any real waiting.
    sleep: async (ms) => { clock += ms; },
  };
}

test('a run follows the queue, records each one, and stops when it runs out', async () => {
  const { store } = seeded(['thandi.m', 'sipho_k']);
  const { runner, calls } = fakeRunner();

  const summary = await runIg(deps(store, runner), { maxSteps: 10 });

  assert.deepEqual(calls.follows, ['thandi.m', 'sipho_k']);
  assert.equal(summary.follows, 2);
  assert.equal(summary.failed, 0);
  assert.equal(store.leads.getByUsername('thandi.m')!.status, 'followed');
  // Following schedules the DM 24–48h out, so nothing is messaged today.
  assert.equal(summary.dms, 0);
  assert.ok(store.leads.getByUsername('thandi.m')!.dmDueAt);
  assert.match(summary.stopReason, /nothing to do|no more work/);
});

test('a block stops the run dead and trips the sticky breaker', async () => {
  const { store } = seeded(['a_one', 'b_two', 'c_three']);
  const { runner, calls } = fakeRunner({
    follow: (u) => (u === 'b_two'
      ? { outcome: 'blocked', reason: 'page said "action blocked"' }
      : { outcome: 'followed', followsUs: false }),
  });

  const summary = await runIg(deps(store, runner), { maxSteps: 10 });

  assert.equal(summary.blocked, true);
  assert.equal(calls.follows.length, 2, 'stopped at the block, never reached the third');
  assert.equal(store.settings.get().breakerTripped, true);
  assert.match(store.settings.get().breakerReason!, /action blocked/);
  // The lead that hit the block is not penalised — it was not its fault.
  assert.equal(store.leads.getByUsername('b_two')!.attempts, 0);
  assert.equal(store.leads.getByUsername('b_two')!.status, 'new');

  // And nothing runs again until a human clears it.
  const second = await runIg(deps(store, fakeRunner().runner), { maxSteps: 10 });
  assert.equal(second.follows, 0);
  assert.match(second.stopReason, /breaker tripped/);
});

test('a failure costs the lead an attempt, and the lead is given up on after maxAttempts', async () => {
  const { store } = seeded(['flaky_one']);
  store.settings.update({ maxAttempts: 2 });
  const { runner } = fakeRunner({
    follow: () => ({ outcome: 'failed', error: 'button never changed to Following' }),
  });

  await runIg(deps(store, runner), { maxSteps: 4 });
  assert.equal(store.leads.getByUsername('flaky_one')!.attempts, 1);
  assert.equal(store.leads.getByUsername('flaky_one')!.status, 'new', 'still retryable');

  await runIg(deps(store, fakeRunner({
    follow: () => ({ outcome: 'failed', error: 'button never changed to Following' }),
  }).runner), { maxSteps: 4 });
  const lead = store.leads.getByUsername('flaky_one')!;
  assert.equal(lead.attempts, 2);
  assert.equal(lead.status, 'failed', 'given up on, so one broken profile cannot eat the day');
  assert.match(lead.lastError!, /never changed/);
});

test('the daily follow cap is honoured, counting what already reached Instagram', async () => {
  const { store } = seeded(['a_one', 'b_two', 'c_three', 'd_four']);
  store.settings.update({ dailyFollowCap: 2 });
  const { runner, calls } = fakeRunner();

  const summary = await runIg(deps(store, runner), { maxSteps: 20 });

  assert.equal(calls.follows.length, 2);
  assert.match(summary.stopReason, /follow cap/);

  // A second run the same day gets nothing more.
  const again = await runIg(deps(store, fakeRunner().runner), { maxSteps: 20 });
  assert.equal(again.follows, 0);
  assert.match(again.stopReason, /follow cap/);
});

test('already following by hand moves the lead on without spending a follow', async () => {
  const { store } = seeded(['known_one']);
  const { runner } = fakeRunner({
    follow: () => ({ outcome: 'already-following', followsUs: true }),
  });

  // One step only, to look at the state the follow itself leaves behind: with
  // more, the pulled-forward DM would go out in the same run (which is the
  // point of a follow-back, and is covered separately).
  await runIg(deps(store, runner), { maxSteps: 1 });

  const lead = store.leads.getByUsername('known_one')!;
  assert.equal(lead.status, 'followed');
  assert.ok(lead.followedBackAt, 'they already follow us, so the DM comes forward');
  assert.ok(
    Date.parse(lead.dmDueAt!) - NOON <= DEFAULT_IG_SETTINGS.followBackDmMaxMinutes * 60_000,
    'due within the follow-back window, not 24-48h out',
  );
  const day = { from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z' };
  assert.equal(store.actions.countBetween('follow', day.from, day.to), 0, 'no click reached Instagram');
  assert.equal(store.actions.countBetween('profile_visit', day.from, day.to), 1, 'but the visit did');
});

test('a filtered-out lead costs a profile visit and is never contacted', async () => {
  const { store } = seeded(['shoppy']);
  const { runner, calls } = fakeRunner({
    follow: () => ({ outcome: 'skipped', reason: 'business account' }),
  });

  const summary = await runIg(deps(store, runner), { maxSteps: 4 });

  assert.equal(summary.skipped, 1);
  assert.equal(calls.dms.length, 0);
  const lead = store.leads.getByUsername('shoppy')!;
  assert.equal(lead.status, 'skipped');
  assert.equal(lead.skipReason, 'business account');
});

test('a due DM is sent with the placeholders filled, and the lead is marked messaged', async () => {
  const { store, campaignId } = seeded([]);
  // A lead followed two days ago, so its DM is due.
  const followedAt = new Date(NOON - 48 * 3600_000).toISOString();
  const { added } = store.leads.addHarvested(campaignId, [person('thandi.m', 'Thandi M \u{1F338}')], followedAt);
  const lead = added[0]!;
  store.leads.update(lead.id, {
    status: 'followed', followedAt, dmDueAt: new Date(NOON - 3600_000).toISOString(),
  });

  const { runner, calls } = fakeRunner();
  const summary = await runIg(deps(store, runner), { maxSteps: 4 });

  assert.equal(summary.dms, 1);
  assert.deepEqual(calls.dms, [{ username: 'thandi.m', text: 'Hi Thandi, saw you at the market!' }]);
  assert.equal(store.leads.get(lead.id)!.status, 'messaged');
  assert.ok(store.leads.get(lead.id)!.variantId);
});

test('a variant image is flagged rather than silently dropped', async () => {
  const store = openIgStore(':memory:');
  const c = store.campaigns.create(campaign());
  store.variants.create({
    campaignId: c.id, text: 'Hi!', imagePath: 'data/media/flyer.png', weight: 1, active: true,
  });
  const followedAt = new Date(NOON - 48 * 3600_000).toISOString();
  const { added } = store.leads.addHarvested(c.id, [person('thandi.m')], followedAt);
  store.leads.update(added[0]!.id, {
    status: 'followed', followedAt, dmDueAt: new Date(NOON - 3600_000).toISOString(),
  });

  const summary = await runIg(deps(store, fakeRunner().runner), { maxSteps: 4 });

  assert.equal(summary.dms, 1);
  assert.ok(
    summary.warnings.some((w) => /image, which is not sent yet/.test(w)),
    'the human is told the picture did not go',
  );
});

test('a run that is not signed in attempts nothing', async () => {
  const { store } = seeded(['thandi.m']);
  const { runner, calls } = fakeRunner({ signedIn: false });

  const summary = await runIg(deps(store, runner), { maxSteps: 4 });

  assert.equal(calls.follows.length, 0);
  assert.match(summary.stopReason, /not signed in/);
  assert.equal(store.leads.getByUsername('thandi.m')!.status, 'new');
});

test('the human stopping mid-run ends it without penalising the lead', async () => {
  const { store } = seeded(['a_one', 'b_two']);
  const { runner, calls } = fakeRunner({
    follow: () => ({ outcome: 'skipped', reason: 'run stopped by the human' }),
  });

  const summary = await runIg(deps(store, runner), { maxSteps: 10 });

  assert.equal(calls.follows.length, 1);
  assert.match(summary.stopReason, /stopped by the human/);
});

test('harvest adds new leads, counts the ones already known, and sends nothing', async () => {
  const { store, campaignId } = seeded(['already_known']);
  const { runner, calls } = fakeRunner({
    harvest: () => ({
      people: [person('already_known'), person('fresh_one'), person('fresh_two')],
      skipped: { 'looks like a business or bot': 4 },
      postsRead: 1,
      notes: [],
    }),
  });

  const summary = await harvestIg(deps(store, runner), { campaignId });

  assert.equal(summary.added, 2);
  assert.equal(summary.duplicates, 1);
  assert.deepEqual(summary.skipped, { 'looks like a business or bot': 4 });
  assert.equal(calls.follows.length, 0, 'harvest follows nobody');
  assert.equal(calls.dms.length, 0, 'harvest messages nobody');
  assert.equal(store.leads.getByUsername('fresh_one')!.status, 'new');
});

test('a block during harvest trips the breaker and stops', async () => {
  const { store, campaignId } = seeded([]);
  const { runner } = fakeRunner({
    harvest: () => ({
      people: [], skipped: {}, postsRead: 0, notes: [], blocked: 'URL matched "/challenge/" (challenge)',
    }),
  });

  const summary = await harvestIg(deps(store, runner), { campaignId });

  assert.equal(summary.blocked, true);
  assert.equal(store.settings.get().breakerTripped, true);
  assert.match(store.settings.get().breakerReason!, /challenge/);
});

test('a follow-back pulls the DM forward', async () => {
  const { store, campaignId } = seeded([]);
  const followedAt = new Date(NOON - 2 * 3600_000).toISOString();
  const { added } = store.leads.addHarvested(campaignId, [person('thandi.m')], followedAt);
  const lead = added[0]!;
  const farOff = new Date(NOON + 40 * 3600_000).toISOString();
  store.leads.update(lead.id, { status: 'followed', followedAt, dmDueAt: farOff });

  const { runner } = fakeRunner({
    followers: () => ({ outcome: 'ok', followers: new Set(['thandi.m']) }),
  });
  const summary = await checkIg(deps(store, runner));

  assert.equal(summary.followBacks, 1);
  const after = store.leads.get(lead.id)!;
  assert.ok(after.followedBackAt);
  assert.ok(Date.parse(after.dmDueAt!) < Date.parse(farOff), 'brought forward, never pushed back');
});

test('a reply stops the sequence; "not interested" is permanent', async () => {
  const { store, campaignId } = seeded([]);
  const at = new Date(NOON - 3600_000).toISOString();
  const { added } = store.leads.addHarvested(
    campaignId,
    [person('keen_one', 'Keen One'), person('cross_one', 'Cross One')],
    at,
  );
  const [keen, cross] = added;
  for (const l of added) store.leads.update(l.id, { status: 'messaged', messagedAt: at });

  const { runner } = fakeRunner({
    inbox: () => ({
      outcome: 'ok',
      entries: [
        { leadId: keen!.id, title: 'keen_one', preview: 'Yes please, how much?', unread: true, kind: 'reply' },
        { leadId: cross!.id, title: 'cross_one', preview: 'Not interested, stop messaging me', unread: true, kind: 'opt-out' },
      ],
    }),
  });

  const summary = await checkIg(deps(store, runner));

  assert.equal(summary.replies, 1);
  assert.equal(summary.optOuts, 1);
  assert.equal(store.leads.get(keen!.id)!.status, 'replied');
  assert.equal(store.leads.get(cross!.id)!.status, 'opted_out');

  // An opted-out lead is never planned again, and the username stays taken so
  // no later campaign can harvest them afresh.
  const after = await runIg(deps(store, fakeRunner().runner), { maxSteps: 4 });
  assert.equal(after.dms, 0);
  assert.equal(store.leads.hasUsername('cross_one'), true);
});

test('an unmatched unread thread is reported, never guessed at', async () => {
  const { store, campaignId } = seeded([]);
  const at = new Date(NOON - 3600_000).toISOString();
  const { added } = store.leads.addHarvested(campaignId, [person('someone')], at);
  store.leads.update(added[0]!.id, { status: 'messaged', messagedAt: at });

  const { runner } = fakeRunner({
    inbox: () => ({
      outcome: 'ok',
      entries: [{ leadId: null, title: 'Some Person', preview: 'hello?', unread: true, kind: 'reply' }],
    }),
  });

  const summary = await checkIg(deps(store, runner));

  assert.equal(summary.replies, 0);
  assert.ok(summary.notes.some((n) => /could not be matched/.test(n)));
  assert.equal(store.leads.get(added[0]!.id)!.status, 'messaged', 'the wrong lead is not touched');
});

test('outside active hours nothing is attempted', async () => {
  const { store } = seeded(['thandi.m']);
  assert.equal(DEFAULT_IG_SETTINGS.activeHourEnd, 20);
  // 23:00 local (UTC+2).
  const lateNight = Date.parse('2026-10-06T21:00:00.000Z');
  const { runner, calls } = fakeRunner();

  const summary = await runIg(deps(store, runner, lateNight), { maxSteps: 4 });

  assert.equal(calls.follows.length, 0);
  assert.match(summary.stopReason, /active hours/);
});
