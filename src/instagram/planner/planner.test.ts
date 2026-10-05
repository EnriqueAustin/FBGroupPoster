import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, dmDueAfterFollow, dmDueAfterFollowBack, type PlanInput } from './planner.ts';
import {
  markBlocked, markFailed, markFollowed, markFollowedBack, markMessaged, markOptedOut, markSkipped,
} from './lifecycle.ts';
import { openIgStore } from '../store/sqlite-store.ts';
import { mulberry32 } from '../../core/rng.ts';
import {
  DEFAULT_FILTERS, DEFAULT_IG_SETTINGS, type IgCampaign, type IgLead, type IgMessageVariant,
} from '../domain/types.ts';

// Africa/Johannesburg is UTC+2 with no DST: 10:00 local = 08:00Z.
const TEN_AM = '2026-10-06T08:00:00.000Z';
const H = 3_600_000;

const camp = (id: number, over: Partial<IgCampaign> = {}): IgCampaign => ({
  id, name: `c${id}`, active: true, sources: [], postsPerSource: 1, maxLeadsPerPost: 50,
  harvestLikers: true, harvestCommenters: true, dmDelayMinHours: 24, dmDelayMaxHours: 48,
  filters: DEFAULT_FILTERS, createdAt: TEN_AM, ...over,
});

let nextId = 1;
const lead = (over: Partial<IgLead> = {}): IgLead => ({
  id: nextId++, username: `u${nextId}`, displayName: null, campaignId: 1, sourceHandle: 's',
  sourcePostUrl: null, source: 'liker', status: 'new', skipReason: null,
  harvestedAt: '2026-10-05T08:00:00.000Z', followedAt: null, followedBackAt: null, dmDueAt: null,
  messagedAt: null, variantId: null, repliedAt: null, attempts: 0, lastError: null, ...over,
});

const variant = (id: number, campaignId = 1, over: Partial<IgMessageVariant> = {}): IgMessageVariant => ({
  id, campaignId, text: `v${id}`, imagePath: null, weight: 1, active: true, createdAt: TEN_AM, ...over,
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: TEN_AM, settings: DEFAULT_IG_SETTINGS, campaigns: [camp(1)], leads: [],
  variants: [variant(1), variant(2)], doneToday: { follow: 0, dm: 0, profileVisit: 0 },
  lastDmVariantId: null, seed: 7, ...over,
});

test('follows stop at the daily follow cap', () => {
  const leads = Array.from({ length: 100 }, () => lead());
  const p = plan(input({ leads, doneToday: { follow: 20, dm: 0, profileVisit: 20 } }));
  assert.equal(p.steps.length, DEFAULT_IG_SETTINGS.dailyFollowCap - 20);
  assert.ok(p.steps.every((s) => s.kind === 'follow'));
  assert.equal(p.stopReason, 'daily follow cap reached');
});

test('the profile-visit cap also limits follows', () => {
  const leads = Array.from({ length: 50 }, () => lead());
  const p = plan(input({ leads, doneToday: { follow: 0, dm: 0, profileVisit: DEFAULT_IG_SETTINGS.dailyProfileVisitCap - 2 } }));
  assert.equal(p.steps.length, 2);
});

test('DMs go out only when due; due ones are taken, future ones today are waited for', () => {
  const dueNow = lead({ status: 'followed', dmDueAt: '2026-10-06T07:00:00.000Z' });
  const dueAtNoon = lead({ status: 'followed', dmDueAt: '2026-10-06T10:00:00.000Z' });
  const dueTomorrow = lead({ status: 'followed', dmDueAt: '2026-10-07T08:00:00.000Z' });
  const p = plan(input({ leads: [dueTomorrow, dueAtNoon, dueNow] }));
  assert.deepEqual(p.steps.map((s) => s.leadId), [dueNow.id, dueAtNoon.id]);
  assert.equal(p.steps[0]!.at, TEN_AM);
  assert.equal(p.steps[1]!.at, '2026-10-06T10:00:00.000Z');
});

test('DMs and follows alternate when both are ready', () => {
  const leads = [
    ...Array.from({ length: 4 }, () => lead({ status: 'followed', dmDueAt: '2026-10-05T08:00:00.000Z' })),
    ...Array.from({ length: 4 }, () => lead()),
  ];
  const kinds = plan(input({ leads })).steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['dm', 'follow', 'dm', 'follow', 'dm', 'follow', 'dm', 'follow']);
});

test('variants never repeat back to back, including across runs', () => {
  const leads = Array.from({ length: 10 }, () => lead({ status: 'followed', dmDueAt: '2026-10-05T08:00:00.000Z' }));
  const steps = plan(input({ leads, lastDmVariantId: 1 })).steps;
  const ids = steps.map((s) => (s.kind === 'dm' ? s.variantId : 0));
  assert.equal(ids[0], 2, 'the variant used last run is not reused first');
  for (let i = 1; i < ids.length; i++) assert.notEqual(ids[i], ids[i - 1]);
});

test('gaps between steps stay within the configured range', () => {
  const leads = Array.from({ length: 15 }, () => lead());
  const at = plan(input({ leads })).steps.map((s) => Date.parse(s.at));
  for (let i = 1; i < at.length; i++) {
    const gap = (at[i]! - at[i - 1]!) / 60_000;
    assert.ok(gap >= DEFAULT_IG_SETTINGS.minGapMinutes && gap <= DEFAULT_IG_SETTINGS.maxGapMinutes, `gap ${gap}`);
  }
});

test('nothing outside active hours, nothing past their end', () => {
  const leads = Array.from({ length: 200 }, () => lead());
  assert.match(plan(input({ leads, now: '2026-10-06T04:00:00.000Z' })).stopReason, /outside active hours/);
  // 19:40 local: only a few minutes left before 20:00.
  const late = plan(input({ leads, now: '2026-10-06T17:40:00.000Z' }));
  assert.ok(late.steps.length >= 1 && late.steps.length <= 7);
  assert.ok(late.steps.every((s) => s.at < '2026-10-06T18:00:00.000Z'));
  assert.equal(late.stopReason, 'end of active hours');
});

test('a tripped breaker plans nothing', () => {
  const p = plan(input({ leads: [lead()], settings: { ...DEFAULT_IG_SETTINGS, breakerTripped: true, breakerReason: 'action blocked' } }));
  assert.equal(p.steps.length, 0);
  assert.match(p.stopReason, /action blocked/);
});

test('paused campaigns and exhausted leads are left alone', () => {
  const p = plan(input({
    campaigns: [camp(1), camp(2, { active: false })],
    leads: [lead({ campaignId: 2 }), lead({ attempts: 3 }), lead()],
  }));
  assert.equal(p.steps.length, 1);
});

test('a campaign with no active message is warned about, not silently stalled', () => {
  const p = plan(input({
    variants: [variant(1, 1, { active: false })],
    leads: [lead({ status: 'followed', dmDueAt: '2026-10-05T08:00:00.000Z' })],
  }));
  assert.equal(p.steps.length, 0);
  assert.match(p.warnings[0]!, /no active message/);
});

test('follows round-robin across campaigns', () => {
  const leads = [
    ...Array.from({ length: 5 }, () => lead({ campaignId: 1 })),
    ...Array.from({ length: 5 }, () => lead({ campaignId: 2 })),
  ];
  const p = plan(input({ campaigns: [camp(1), camp(2)], leads }));
  assert.deepEqual(p.steps.slice(0, 4).map((s) => s.campaignId), [1, 2, 1, 2]);
});

test('the same seed gives the same plan', () => {
  const leads = Array.from({ length: 10 }, () => lead());
  assert.deepEqual(plan(input({ leads })), plan(input({ leads })));
});

test('DM due 24–48h after follow; a follow-back pulls it forward, never back', () => {
  const rng = mulberry32(1);
  const t0 = Date.parse(TEN_AM);
  for (let i = 0; i < 50; i++) {
    const due = dmDueAfterFollow(t0, { dmDelayMinHours: 24, dmDelayMaxHours: 48 }, rng);
    assert.ok(due >= t0 + 24 * H && due <= t0 + 48 * H);
    const back = dmDueAfterFollowBack(due, t0 + 2 * H, DEFAULT_IG_SETTINGS, rng);
    assert.ok(back >= t0 + 2 * H + 30 * 60_000 && back <= t0 + 5 * H);
    // A follow-back seen after the DM was already due changes nothing.
    assert.equal(dmDueAfterFollowBack(t0 + H, t0 + 30 * H, DEFAULT_IG_SETTINGS, rng), t0 + H);
  }
});

// --- lifecycle, against a real (in-memory) store ----------------------------

function setup() {
  const store = openIgStore(':memory:');
  const c = store.campaigns.create({
    name: 'c', active: true, sources: ['src'], postsPerSource: 1, maxLeadsPerPost: 50,
    harvestLikers: true, harvestCommenters: true, dmDelayMinHours: 24, dmDelayMaxHours: 48,
    filters: DEFAULT_FILTERS,
  });
  const v = store.variants.create({ campaignId: c.id, text: 'Hi {first_name}', imagePath: null, weight: 1, active: true });
  const { added } = store.leads.addHarvested(c.id, ['a', 'b', 'c'].map((username) => ({
    username, displayName: null, source: 'liker' as const, sourceHandle: 'src', sourcePostUrl: null,
  })), TEN_AM);
  return { store, c, v, leads: added };
}

const dayCount = (store: ReturnType<typeof openIgStore>, kind: 'follow' | 'dm' | 'profile_visit') =>
  store.actions.countBetween(kind, '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z');

test('follow → follow-back → DM, with the caps counted', () => {
  const { store, v, leads } = setup();
  const id = leads[0]!.id;

  let l = markFollowed(store, id, TEN_AM);
  assert.equal(l.status, 'followed');
  const due = Date.parse(l.dmDueAt!);
  assert.ok(due >= Date.parse(TEN_AM) + 24 * H && due <= Date.parse(TEN_AM) + 48 * H);
  assert.equal(dayCount(store, 'follow'), 1);
  assert.equal(dayCount(store, 'profile_visit'), 1);

  l = markFollowedBack(store, id, '2026-10-06T12:00:00.000Z');
  assert.ok(Date.parse(l.dmDueAt!) <= Date.parse('2026-10-06T15:00:00.000Z'));

  l = markMessaged(store, id, v.id, '2026-10-06T13:00:00.000Z');
  assert.equal(l.status, 'messaged');
  assert.equal(store.actions.lastDmVariantId(), v.id);
  assert.equal(dayCount(store, 'dm'), 1);
});

test('already following by hand: no follow counted, and a mutual follow DMs soon', () => {
  const { store, leads } = setup();
  const l = markFollowed(store, leads[0]!.id, TEN_AM, { alreadyFollowing: true, followsUs: true });
  assert.equal(dayCount(store, 'follow'), 0);
  assert.ok(Date.parse(l.dmDueAt!) <= Date.parse(TEN_AM) + 3 * H);
});

test('skips cost a profile visit only; failures give up after maxAttempts', () => {
  const { store, leads } = setup();
  markSkipped(store, leads[0]!.id, 'private account', TEN_AM);
  assert.equal(store.leads.get(leads[0]!.id)!.status, 'skipped');
  assert.equal(dayCount(store, 'follow'), 0);
  assert.equal(dayCount(store, 'profile_visit'), 1);

  const id = leads[1]!.id;
  markFailed(store, id, 'follow', 'button not found', TEN_AM);
  markFailed(store, id, 'follow', 'button not found', TEN_AM);
  assert.equal(store.leads.get(id)!.status, 'new');
  markFailed(store, id, 'follow', 'button not found', TEN_AM);
  assert.equal(store.leads.get(id)!.status, 'failed');
  assert.equal(dayCount(store, 'follow'), 3, 'failed clicks still count against the cap');
});

test('a block trips the breaker; opt-out is final', () => {
  const { store, leads } = setup();
  markBlocked(store, leads[0]!.id, 'follow', 'Action Blocked', TEN_AM);
  assert.equal(store.settings.get().breakerTripped, true);
  assert.equal(store.leads.get(leads[0]!.id)!.status, 'new', 'the lead is not penalised');

  markOptedOut(store, leads[1]!.id, 'said not interested');
  assert.equal(store.leads.get(leads[1]!.id)!.status, 'opted_out');
});
