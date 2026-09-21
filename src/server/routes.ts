/**
 * REST API over the Store. Handlers stay thin: validate, call the store or the
 * scheduler, map the result. No scheduling logic lives here.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Scheduler, Store } from '../domain/contracts.ts';
import { badRequest, must, parseBody, parseParams, parseQuery, sendError } from './http.ts';
import { createJobRunner } from './jobs.ts';
import { importGroups } from '../bootstrap.ts';
import { createGroupDiscoverer } from '../runner/discover-groups.ts';
import { createRunner } from '../runner/playwright-runner.ts';
import { createOrchestrator } from '../orchestrator.ts';
import { commitRound, planRound } from '../scheduler/rounds.ts';
import { startOfDayUtcMs, toIso } from '../scheduler/time.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const composerType = z.enum(['status', 'listing']);

const businessBody = z.object({
  name: z.string().min(1),
  active: z.boolean().default(true),
  dailyCapShare: z.number().min(0).max(1).nullable().default(null),
});

const groupPatch = z.object({
  name: z.string().min(1).optional(),
  composerType: composerType.optional(),
  active: z.boolean().optional(),
  cooldownDaysOverride: z.number().int().min(0).nullable().optional(),
  rulesNotes: z.string().optional(),
  quarantinedUntil: z.string().datetime().nullable().optional(),
  quarantineReason: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

/** With ~100 groups, curating one row at a time is unusable. */
const bulkBody = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  patch: groupPatch,
});

const adBody = z.object({
  businessId: z.number().int().positive(),
  name: z.string().min(1),
  composerType,
  active: z.boolean().default(true),
});

const variantBody = z.object({
  adId: z.number().int().positive(),
  caption: z.string().min(1),
  listingTitle: z.string().nullable().default(null),
  listingPriceCents: z.number().int().min(0).nullable().default(null),
  listingCategory: z.string().nullable().default(null),
  listingLocation: z.string().nullable().default(null),
  imagePaths: z.array(z.string()).default([]),
  weight: z.number().int().min(1).default(1),
  active: z.boolean().default(true),
});

const settingsPatch = z.object({
  dailyCap: z.number().int().min(1).max(200).optional(),
  perGroupCooldownDays: z.number().int().min(0).max(365).optional(),
  perGroupAdCooldownDays: z.number().int().min(0).max(365).optional(),
  minGapMinutes: z.number().int().min(1).optional(),
  maxGapMinutes: z.number().int().min(1).optional(),
  activeHourStart: z.number().int().min(0).max(23).optional(),
  activeHourEnd: z.number().int().min(1).max(24).optional(),
  timezone: z.string().min(1).optional(),
  defaultRunnerMode: z.enum(['assisted', 'auto']).optional(),
  // Round posting. The upper bounds are not arbitrary: they are the point past
  // which this stops being "a few rounds a day" and becomes the burst pattern
  // the whole tool exists to avoid.
  roundsPerDay: z.number().int().min(1).max(8).optional(),
  minHoursBetweenRounds: z.number().int().min(1).max(24).optional(),
  roundMinGapMinutes: z.number().int().min(1).optional(),
  roundMaxGapMinutes: z.number().int().min(1).optional(),
  roundDailyCap: z.number().int().min(1).max(500).nullable().optional(),
}).refine((s) => s.minGapMinutes === undefined || s.maxGapMinutes === undefined || s.minGapMinutes <= s.maxGapMinutes,
  { message: 'minGapMinutes must be <= maxGapMinutes' })
  .refine((s) => s.activeHourStart === undefined || s.activeHourEnd === undefined || s.activeHourStart < s.activeHourEnd,
    { message: 'activeHourStart must be before activeHourEnd' })
  .refine((s) => s.roundMinGapMinutes === undefined || s.roundMaxGapMinutes === undefined
    || s.roundMinGapMinutes <= s.roundMaxGapMinutes,
    { message: 'roundMinGapMinutes must be <= roundMaxGapMinutes' });

const planQuery = z.object({
  days: z.coerce.number().int().min(1).max(60).default(7),
  seed: z.coerce.number().int().optional(),
});

export const MEDIA_DIR = path.join('data', 'media');

export function registerRoutes(app: FastifyInstance, store: Store, scheduler: Scheduler): void {
  app.setErrorHandler((err, _req, reply) => { sendError(reply, err); });

  // --- businesses ------------------------------------------------------------
  app.get('/api/businesses', () => store.businesses.list());

  app.post('/api/businesses', (req) => store.businesses.create(parseBody(businessBody, req)));

  app.patch('/api/businesses/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.businesses.get(id), 'business');
    return store.businesses.update(id, parseBody(businessBody.partial(), req));
  });

  // --- groups ----------------------------------------------------------------
  app.get('/api/groups', (req) => {
    const q = parseQuery(z.object({
      businessId: z.coerce.number().int().positive().optional(),
      activeOnly: z.coerce.boolean().optional(),
      composerType: composerType.optional(),
    }), req);
    return store.groups.list(q);
  });

  app.patch('/api/groups/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.groups.get(id), 'group');
    return store.groups.update(id, parseBody(groupPatch, req));
  });

  app.post('/api/groups/bulk', (req) => {
    const { ids, patch } = parseBody(bulkBody, req);
    return ids.map((id) => {
      must(store.groups.get(id), `group ${id}`);
      return store.groups.update(id, patch);
    });
  });

  app.get('/api/businesses/:id/assignments', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.businesses.get(id), 'business');
    return store.groups.assignments(id);
  });

  app.put('/api/businesses/:id/assignments', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.businesses.get(id), 'business');
    const { groupIds } = parseBody(z.object({ groupIds: z.array(z.number().int().positive()) }), req);
    store.groups.setAssignments(id, groupIds);
    return store.groups.assignments(id);
  });

  // --- ads and variants ------------------------------------------------------
  app.get('/api/ads', (req) => {
    const q = parseQuery(z.object({ businessId: z.coerce.number().int().positive().optional() }), req);
    return store.ads.list(q).map((ad) => ({ ...ad, variants: store.ads.variants(ad.id) }));
  });

  app.post('/api/ads', (req) => {
    const body = parseBody(adBody, req);
    must(store.businesses.get(body.businessId), 'business');
    return store.ads.create(body);
  });

  app.patch('/api/ads/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.ads.get(id), 'ad');
    return store.ads.update(id, parseBody(adBody.partial(), req));
  });

  app.post('/api/variants', (req) => {
    const body = parseBody(variantBody, req);
    const ad = must(store.ads.get(body.adId), 'ad');
    if (ad.composerType === 'listing' && !body.listingTitle) {
      throw badRequest('a listing variant needs a title');
    }
    return store.ads.createVariant(body);
  });

  app.patch('/api/variants/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.ads.getVariant(id), 'variant');
    return store.ads.updateVariant(id, parseBody(variantBody.partial(), req));
  });

  // --- media -----------------------------------------------------------------
  app.post('/api/media', async (req) => {
    const file = await (req as unknown as { file(): Promise<{ filename: string; toBuffer(): Promise<Buffer> } | undefined> }).file();
    if (!file) throw badRequest('no file in the request');
    await mkdir(MEDIA_DIR, { recursive: true });
    // Prefix with a timestamp so re-uploading the same filename never silently
    // replaces an image an existing variant still points at.
    const safe = file.filename.replace(/[^\w.\-]/g, '_');
    const rel = path.join(MEDIA_DIR, `${Date.now()}-${safe}`);
    await writeFile(rel, await file.toBuffer());
    return { path: rel };
  });

  // --- planning --------------------------------------------------------------
  /**
   * The seed is always chosen here and returned with the plan. Left to the
   * planner it defaulted to the current minute, so a dry run read at 14:03 and
   * committed at 14:05 queued a DIFFERENT schedule from the one reviewed. The UI
   * now passes the dry run's seed back to commit.
   */
  const buildPlan = (days: number, seed?: number) => {
    const now = new Date();
    const chosen = seed ?? Math.floor(now.getTime() / 60_000);
    const plan = scheduler.plan({
      now: now.toISOString(),
      windowEnd: new Date(now.getTime() + days * 86_400_000).toISOString(),
      seed: chosen,
    });
    return { ...plan, seed: chosen };
  };

  app.post('/api/plan/dry-run', (req) => {
    const { days, seed } = parseQuery(planQuery, req);
    return buildPlan(days, seed);
  });

  app.post('/api/plan/commit', (req) => {
    const { days, seed } = parseQuery(planQuery, req);
    const { replacePending } = parseBody(
      z.object({ replacePending: z.boolean().default(true) }), req,
    );
    // The planner reads history, never the queue, so the plan can be built
    // before anything is cleared. An empty plan must not wipe a queue that was
    // still useful — that used to happen, followed by a "Dry run" banner.
    const plan = buildPlan(days, seed);
    if (plan.posts.length === 0) return { committed: 0, cleared: 0, plan };
    // Replanning drops queued-but-unposted items; history in post_log is
    // untouched, so cooldowns survive it.
    const cleared = replacePending ? store.queue.clearPending() : 0;
    return { committed: scheduler.commit(plan).length, cleared, plan };
  });

  // --- queue and log ---------------------------------------------------------
  app.get('/api/queue', (req) => {
    const q = parseQuery(z.object({
      status: z.enum(['pending', 'due', 'running', 'posted', 'skipped', 'failed', 'cancelled']).optional(),
    }), req);
    return store.queue.list(q);
  });

  app.patch('/api/queue/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.queue.get(id), 'queue item');
    const body = parseBody(z.object({
      status: z.enum(['pending', 'cancelled']).optional(),
      scheduledFor: z.string().datetime().optional(),
    }), req);
    return store.queue.update(id, body);
  });

  /**
   * Permanently delete queue rows, by id or wholesale by status.
   *
   * Distinct from PATCH ... {status:'cancelled'}: cancelling keeps the row so
   * you can see it was planned and Retry it. Deleting is for clearing the
   * clutter that builds up once you have decided you do not want any of it.
   *
   * History is unaffected — post_log.queue_item_id is ON DELETE SET NULL, so
   * the record that a post happened outlives the queue row it came from.
   */
  app.post('/api/queue/delete', (req) => {
    const body = parseBody(z.object({
      ids: z.array(z.number().int().positive()).optional(),
      statuses: z.array(z.enum(['pending', 'due', 'running', 'posted', 'skipped', 'failed', 'cancelled']))
        .optional(),
    }).refine((x) => (x.ids?.length ?? 0) > 0 || (x.statuses?.length ?? 0) > 0,
      { message: 'give either ids or statuses' }), req);

    // 'running' is excluded from a status sweep on purpose: deleting the row a
    // live run is holding strands the orchestrator mid-post.
    const statuses = (body.statuses ?? []).filter((x) => x !== 'running');
    const deleted = store.queue.remove(body.ids ?? []) + store.queue.removeByStatus(statuses);
    return { deleted };
  });

  app.get('/api/log', (req) => {
    const q = parseQuery(z.object({
      groupId: z.coerce.number().int().positive().optional(),
      businessId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }), req);
    return store.log.list(q);
  });

  /**
   * Permanently delete history rows.
   *
   * post_log is what every cooldown is computed from, so deleting a 'posted'
   * row tells the planner that group never heard from you and frees it to be
   * posted to again immediately. That is occasionally what you want (a post
   * that was recorded but never actually appeared) and is otherwise a way to
   * walk straight into the pattern the cooldowns exist to prevent, hence
   * `confirmPosted` — deleting successful posts has to be asked for by name.
   */
  app.post('/api/log/delete', (req) => {
    const body = parseBody(z.object({
      ids: z.array(z.number().int().positive()).optional(),
      outcomes: z.array(z.enum(['posted', 'skipped', 'failed', 'blocked'])).optional(),
      confirmPosted: z.boolean().default(false),
    }).refine((x) => (x.ids?.length ?? 0) > 0 || (x.outcomes?.length ?? 0) > 0,
      { message: 'give either ids or outcomes' }), req);

    if (!body.confirmPosted) {
      const wouldTouchPosted = (body.outcomes ?? []).includes('posted')
        // One COUNT over the given ids. This used to reload the entire log
        // once per id, which is quadratic in exactly the case — a big bulk
        // delete — where it hurts.
        || store.log.countIdsWithOutcome(body.ids ?? [], 'posted') > 0;
      if (wouldTouchPosted) {
        throw badRequest(
          'that selection includes successful posts, which are what the cooldowns are '
          + 'computed from — deleting them lets those groups be posted to again straight '
          + 'away. Re-send with confirmPosted to go ahead.');
      }
    }

    const deleted = store.log.remove(body.ids ?? []) + store.log.removeByOutcome(body.outcomes ?? []);
    return { deleted };
  });

  // --- settings and breaker --------------------------------------------------
  app.get('/api/settings', () => store.settings.get());

  app.patch('/api/settings', (req) => {
    const patch = parseBody(settingsPatch, req);
    const updated = store.settings.update(patch);
    // Queue items carry the mode they were committed with. Without this,
    // switching to auto changed the setting and nothing else: the next run
    // read a queue full of 'assisted' rows and stopped to ask, every time.
    if (patch.defaultRunnerMode) store.queue.setModeForWaiting(patch.defaultRunnerMode);
    return updated;
  });

  // Clearing the breaker is deliberately its own endpoint rather than a
  // settings field, so it can never be flipped off as a side effect of saving
  // an unrelated preference.
  app.post('/api/breaker/clear', () =>
    store.settings.update({ breakerTripped: false, breakerReason: null, breakerTrippedAt: null }));

  // --- rounds: one ad, every selected group, on demand -----------------------
  const roundBody = z.object({
    businessId: z.number().int().positive(),
    adId: z.number().int().positive().optional(),
    /** Drop any unposted round still sitting in the queue first. */
    replaceExisting: z.boolean().default(true),
  });

  app.post('/api/rounds/dry-run', (req) => {
    const { businessId, adId } = parseBody(roundBody, req);
    return planRound(store, { businessId, now: new Date().toISOString(), ...(adId ? { adId } : {}) });
  });

  app.post('/api/rounds/commit', (req) => {
    const { businessId, adId, replaceExisting } = parseBody(roundBody, req);
    if (replaceExisting) store.queue.clearRounds();
    const plan = planRound(store, { businessId, now: new Date().toISOString(), ...(adId ? { adId } : {}) });
    if (plan.posts.length === 0) {
      throw badRequest('no group is eligible for a round right now — see the exclusions in the dry run');
    }
    return { committed: commitRound(store, plan).length, plan };
  });

  // --- jobs: browser work driven from the UI ---------------------------------
  const jobs = createJobRunner();

  app.get('/api/jobs', () => jobs.list().map((j) => ({ ...j, lines: j.lines.slice(-5) })));
  app.get('/api/jobs/current', () => jobs.current());
  app.get('/api/jobs/:id', (req) => {
    const id = String((req.params as { id: string }).id);
    return must(jobs.get(id), 'job');
  });

  app.post('/api/jobs/bootstrap', () =>
    jobs.start('bootstrap', async (h) => {
      h.log('Opening Chrome…');
      const discoverer = createGroupDiscoverer({
        log: h.log,
        // Ask rather than detect. Facebook's two-factor screens differ by
        // account, region and challenge type, so every attempt to recognise
        // them automatically has been a guess that failed on the real one.
        confirmSignIn: async () => (await h.ask(
          'Sign in to Facebook in the Chrome window that just opened — including any '
          + 'code or phone approval. The browser will stay open and nothing will happen '
          + 'until you press continue.',
          [
            { value: 'ok', label: 'I am signed in — continue' },
            { value: 'cancel', label: 'Cancel import' },
          ],
          { kind: 'sign-in' },
        )) === 'ok',
      });
      return importGroups(store, discoverer, h.log);
    }));

  app.post('/api/jobs/post-run', (req) => {
    const { max } = parseBody(z.object({ max: z.number().int().min(1).max(100).default(5) }), req);
    const s = store.settings.get();
    if (s.breakerTripped) throw badRequest('the circuit breaker is tripped — clear it first');

    return jobs.start('post-run', async (h) => {
      const runner = createRunner({
        log: h.log,
        askHuman: (_prompt, context) => h.ask(
          'Ready to post — review it in the browser, then tell me what happened.',
          [
            { value: '', label: 'I posted it' },
            { value: 's', label: 'Skip this one' },
            { value: 'q', label: 'Stop the run' },
          ],
          context,
        ),
      });
      const orchestrator = createOrchestrator({ store, runner, log: h.log });
      return orchestrator.runDue(max);
    });
  });

  /**
   * Plan a round, commit it, and immediately work through it — the "post this
   * ad to all my groups now" button. One call rather than three because the
   * three-step version invites committing a round and forgetting to run it,
   * which then sits in the queue and fires at a time nobody chose.
   */
  app.post('/api/jobs/post-round', (req) => {
    const { businessId, adId } = parseBody(
      z.object({
        businessId: z.number().int().positive(),
        adId: z.number().int().positive().optional(),
      }), req);

    const s = store.settings.get();
    if (s.breakerTripped) throw badRequest('the circuit breaker is tripped — clear it first');
    // jobs.start() refuses a second concurrent job, but it is called AFTER the
    // round is committed. Checking here keeps a rejected start from leaving a
    // committed round in the queue that nobody asked to run.
    if (jobs.current()) throw badRequest('another job is already running — stop it first');

    // Plan before starting the job so an empty or impossible round is a plain
    // 400 the UI can show, not a job that starts and immediately gives up.
    store.queue.clearRounds();
    const plan = planRound(store, {
      businessId, now: new Date().toISOString(), ...(adId ? { adId } : {}),
    });
    if (plan.posts.length === 0) {
      throw badRequest('no group is eligible for a round right now — check Rounds for the reasons');
    }
    const items = commitRound(store, plan);

    return jobs.start('post-run', async (h) => {
      h.log(`Round ${plan.roundId}: ${items.length} group(s), ${s.defaultRunnerMode} mode.`);
      if (plan.warning) h.log(`[warn] ${plan.warning}`);
      h.log(`Pacing: ${s.roundMinGapMinutes}-${s.roundMaxGapMinutes} min between posts. `
        + `Leave this window and the browser open — it finishes in roughly `
        + `${Math.round(items.length * (s.roundMinGapMinutes + s.roundMaxGapMinutes) / 2)} min.`);
      h.log('Between posts the run waits with the browser open; that is not a stall.');

      const runner = createRunner({
        log: h.log,
        askHuman: (_prompt, context) => h.ask(
          'Ready to post — review it in the browser, then tell me what happened.',
          [
            { value: '', label: 'I posted it' },
            { value: 's', label: 'Skip this one' },
            { value: 'q', label: 'Stop the run' },
          ],
          context,
        ),
      });
      const orchestrator = createOrchestrator({ store, runner, log: h.log });
      // A round's posts are scheduled minutes apart, so the run has to WAIT for
      // them rather than stopping the moment nothing is due. The horizon is one
      // gap plus slack: long enough to reach the next post in this round, short
      // enough that a stray far-future item does not hold the browser open.
      const horizonMs = (s.roundMaxGapMinutes + 5) * 60_000;
      return orchestrator.runDue(items.length, horizonMs);
    });
  });

  app.post('/api/jobs/:id/respond', (req) => {
    const id = String((req.params as { id: string }).id);
    const { answer } = parseBody(z.object({ answer: z.string() }), req);
    return jobs.respond(id, answer);
  });

  app.post('/api/jobs/:id/cancel', (req) => {
    const id = String((req.params as { id: string }).id);
    return jobs.cancel(id);
  });

  // --- summary for the dashboard --------------------------------------------
  app.get('/api/summary', () => {
    const s = store.settings.get();
    const groups = store.groups.list();
    const nowIso = new Date().toISOString();
    const waiting = store.queue.list({ status: ['pending', 'due', 'running'] });

    // "Pending" and "due right now" are different things, and conflating them
    // is why a posting run could appear to fire and do nothing: everything was
    // scheduled for the morning.
    const dueNow = waiting.filter((q) => q.scheduledFor <= nowIso);
    const upcoming = waiting.filter((q) => q.scheduledFor > nowIso)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

    return {
      settings: s,
      counts: {
        businesses: store.businesses.list().length,
        groupsTotal: groups.length,
        groupsActive: groups.filter((g) => g.active).length,
        ads: store.ads.list().length,
        queuePending: waiting.length,
        queueDueNow: dueNow.length,
        // A real COUNT: filtering list({limit:1000}) froze this at 1000.
        postedAllTime: store.log.countByOutcome('posted'),
      },
      nextDueAt: upcoming[0]?.scheduledFor ?? null,
      round: {
        // What is left of an in-flight round, so the UI can say "9 of 20 to go"
        // rather than leaving a half-finished round looking like normal queue.
        queued: waiting.filter((q) => q.roundId !== null).length,
        // "Today" is the user's day in settings.timezone — the same day
        // roundDailyCap is enforced against — not the server's local midnight,
        // which differs whenever the machine's zone does (a VPS on UTC, say).
        postedToday: store.log.countRoundPostsBetween(
          toIso(startOfDayUtcMs(Date.now(), s.timezone)), nowIso),
      },
    };
  });

  /**
   * Pull the earliest waiting post forward to now.
   *
   * Deliberately manual: it bypasses the pacing the scheduler chose, which is
   * exactly what you want when testing a single post, and exactly what you do
   * not want habitually. The per-group and per-ad cooldowns are untouched — it
   * only moves the clock on one already-planned item.
   */
  app.post('/api/queue/bring-forward', () => {
    const nowIso = new Date().toISOString();
    const next = store.queue.list({ status: ['pending', 'due'] })
      .filter((q) => q.scheduledFor > nowIso)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];
    if (!next) throw badRequest('nothing is waiting to be brought forward');
    return store.queue.update(next.id, { scheduledFor: nowIso, status: 'pending' });
  });
}
