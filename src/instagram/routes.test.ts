/**
 * API tests for the Instagram module. These drive the real store through
 * Fastify's inject, so validation, wiring and the store mapping are covered
 * in one pass. No socket is opened, and no browser job is started.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openIgStore } from './store/sqlite-store.ts';
import { registerIgRoutes } from './routes.ts';
import { installErrorHandler } from '../core/http.ts';
import { DEFAULT_FILTERS } from './domain/types.ts';

function build() {
  const store = openIgStore(':memory:');
  const app = Fastify();
  installErrorHandler(app);
  registerIgRoutes(app, store);
  return { app, store };
}

const json = (res: { payload: string }) => JSON.parse(res.payload);

const campaignPayload = {
  name: 'Paarl coffee',
  sources: ['@CafeOne', 'cafe_two'],
};

test('creates a campaign, applying the schema defaults and normalising handles', async () => {
  const { app, store } = build();
  const res = await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: campaignPayload });
  assert.equal(res.statusCode, 200);
  const c = json(res);
  assert.deepEqual(c.sources, ['cafeone', 'cafe_two'], 'the @ is dropped and the case folded');
  assert.equal(c.active, true);
  assert.equal(c.postsPerSource, 1);
  assert.deepEqual(c.filters, DEFAULT_FILTERS);
  store.close();
});

test('a campaign needs at least one source, and they must look like handles', async () => {
  const { app, store } = build();
  const none = await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: { name: 'x', sources: [] } });
  assert.equal(none.statusCode, 400);

  const bad = await app.inject({
    method: 'POST', url: '/api/ig/campaigns', payload: { name: 'x', sources: ['not a handle!'] },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error, /invalid body/i);
  store.close();
});

test('a campaign with leads cannot be deleted, only deactivated', async () => {
  const { app, store } = build();
  const c = json(await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: campaignPayload }));
  store.leads.addHarvested(c.id, [{
    username: 'thandi.m', displayName: null, source: 'liker', sourceHandle: 'cafeone', sourcePostUrl: null,
  }], new Date().toISOString());

  const res = await app.inject({ method: 'DELETE', url: `/api/ig/campaigns/${c.id}` });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /deactivate it instead/i);

  const off = await app.inject({ method: 'PATCH', url: `/api/ig/campaigns/${c.id}`, payload: { active: false } });
  assert.equal(json(off).active, false);
  store.close();
});

test('a message with an unknown placeholder is refused before it can go out', async () => {
  const { app, store } = build();
  const c = json(await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: campaignPayload }));

  const bad = await app.inject({
    method: 'POST',
    url: '/api/ig/variants',
    payload: { campaignId: c.id, text: 'Hi {frist_name}, how are you?' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error, /\{frist_name\}/);

  const good = await app.inject({
    method: 'POST',
    url: '/api/ig/variants',
    payload: { campaignId: c.id, text: 'Hi {first_name}, saw you at {username}’s!' },
  });
  assert.equal(good.statusCode, 200);
  assert.equal(json(good).imagePath, null, 'images are not wired to the DM composer yet');
  store.close();
});

test('a variant needs a campaign that exists', async () => {
  const { app, store } = build();
  const res = await app.inject({
    method: 'POST', url: '/api/ig/variants', payload: { campaignId: 999, text: 'Hi!' },
  });
  assert.equal(res.statusCode, 404);
  store.close();
});

test('bulk skip only touches leads nobody has contacted', async () => {
  const { app, store } = build();
  const c = json(await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: campaignPayload }));
  const at = new Date().toISOString();
  const { added } = store.leads.addHarvested(c.id, ['a_one', 'b_two', 'c_three'].map((username) => ({
    username, displayName: null, source: 'liker' as const, sourceHandle: 'cafeone', sourcePostUrl: null,
  })), at);
  // One has already had a message; it must not be rewritten to 'skipped'.
  store.leads.update(added[2]!.id, { status: 'messaged', messagedAt: at });

  const res = await app.inject({
    method: 'POST',
    url: '/api/ig/leads/skip',
    payload: { ids: added.map((l) => l.id), reason: 'too far away' },
  });
  assert.equal(json(res).skipped, 2);
  assert.equal(json(res).requested, 3);
  assert.equal(store.leads.get(added[0]!.id)!.status, 'skipped');
  assert.equal(store.leads.get(added[0]!.id)!.skipReason, 'too far away');
  assert.equal(store.leads.get(added[2]!.id)!.status, 'messaged', 'already contacted, left alone');
  store.close();
});

test('opting a lead out works from any status and is final', async () => {
  const { app, store } = build();
  const c = json(await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: campaignPayload }));
  const at = new Date().toISOString();
  const { added } = store.leads.addHarvested(c.id, [{
    username: 'cross_one', displayName: null, source: 'liker', sourceHandle: 'cafeone', sourcePostUrl: null,
  }], at);
  store.leads.update(added[0]!.id, { status: 'messaged', messagedAt: at });

  const res = await app.inject({
    method: 'POST', url: `/api/ig/leads/${added[0]!.id}/opt-out`, payload: { reason: 'asked us to stop' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).status, 'opted_out');
  // The row stays, so the username can never be harvested afresh.
  assert.equal(store.leads.hasUsername('cross_one'), true);
  store.close();
});

test('settings take a partial patch and keep the rest of the defaults', async () => {
  const { app, store } = build();
  const res = await app.inject({
    method: 'PATCH', url: '/api/ig/settings', payload: { dailyFollowCap: 10, mode: 'auto' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).dailyFollowCap, 10);
  assert.equal(json(res).mode, 'auto');
  assert.equal(json(res).dailyDmCap, 12, 'untouched default survives');

  const silly = await app.inject({ method: 'PATCH', url: '/api/ig/settings', payload: { dailyFollowCap: 5000 } });
  assert.equal(silly.statusCode, 400);
  store.close();
});

test('the breaker is cleared only by asking, and the plan is empty while it is tripped', async () => {
  const { app, store } = build();
  store.settings.tripBreaker('page said "action blocked"', new Date().toISOString());

  const plan = json(await app.inject({ method: 'GET', url: '/api/ig/plan' }));
  assert.deepEqual(plan.steps, []);
  assert.match(plan.stopReason, /breaker tripped/);

  const cleared = json(await app.inject({ method: 'POST', url: '/api/ig/settings/clear-breaker' }));
  assert.equal(cleared.breakerTripped, false);
  assert.equal(cleared.breakerReason, null);
  store.close();
});

test('the dry run reports why it would do nothing', async () => {
  const { app, store } = build();
  const plan = json(await app.inject({ method: 'GET', url: '/api/ig/plan' }));
  assert.deepEqual(plan.steps, []);
  assert.ok(typeof plan.stopReason === 'string' && plan.stopReason.length > 0);
  assert.ok('remaining' in plan);
  store.close();
});

test('lead counts come back for every status', async () => {
  const { app, store } = build();
  const c = json(await app.inject({ method: 'POST', url: '/api/ig/campaigns', payload: campaignPayload }));
  store.leads.addHarvested(c.id, [{
    username: 'thandi.m', displayName: null, source: 'liker', sourceHandle: 'cafeone', sourcePostUrl: null,
  }], new Date().toISOString());

  const counts = json(await app.inject({ method: 'GET', url: '/api/ig/leads/counts' }));
  assert.equal(counts.new, 1);
  assert.equal(counts.messaged, 0);
  assert.equal(counts.opted_out, 0);
  store.close();
});

test('a missing campaign is a 404, not a 500', async () => {
  const { app, store } = build();
  for (const url of ['/api/ig/campaigns/999']) {
    const res = await app.inject({ method: 'PATCH', url, payload: { name: 'x' } });
    assert.equal(res.statusCode, 404);
  }
  store.close();
});
