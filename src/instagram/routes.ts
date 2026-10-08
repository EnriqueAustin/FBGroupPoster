/**
 * The Instagram module's HTTP surface, under /api/ig.
 *
 * Same shape as the Facebook module's routes: thin, validated with zod, and
 * with every long browser job handed to the shared job runner rather than
 * held open on a request. The one module-specific rule is the lane — all
 * Instagram work shares one Chrome profile, so one IG job runs at a time,
 * while a Facebook round carries on beside it.
 *
 * Nothing here decides anything. The planner decides what is due, the
 * lifecycle decides what a lead's state becomes, and the runner decides what
 * the browser does; these routes only carry the request to them.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, must, parseBody, parseParams, parseQuery } from '../core/http.ts';
import { createJobRunner, type JobHandle, type JobRunner } from '../core/jobs.ts';
import type { IgStore } from './domain/contracts.ts';
import { DEFAULT_FILTERS } from './domain/types.ts';
import { checkIg, harvestIg, planNow, runIg } from './orchestrator.ts';
import { IG_LANE } from './runner/auth.ts';
import { createIgRunner } from './runner/playwright-ig-runner.ts';
import { unknownPlaceholders } from './planner/messages.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** A source handle, with or without the @; the store lower-cases them. */
const handle = z.string().trim().min(1).max(31).regex(
  /^@?[A-Za-z0-9._]{1,30}$/,
  { message: 'must be an Instagram handle, e.g. @cafeone' },
);

const filtersBody = z.object({
  skipPrivate: z.boolean(),
  skipBusiness: z.boolean(),
  minFollowers: z.number().int().min(0).nullable(),
  maxFollowers: z.number().int().min(0).nullable(),
  maxFollowing: z.number().int().min(0).nullable(),
  requireBioKeywords: z.array(z.string()),
  excludeBioKeywords: z.array(z.string()),
});

const campaignBody = z.object({
  name: z.string().trim().min(1),
  active: z.boolean().default(true),
  sources: z.array(handle).min(1),
  postsPerSource: z.number().int().min(1).max(12).default(1),
  maxLeadsPerPost: z.number().int().min(1).max(500).default(50),
  harvestLikers: z.boolean().default(true),
  harvestCommenters: z.boolean().default(true),
  dmDelayMinHours: z.number().int().min(0).max(336).default(24),
  dmDelayMaxHours: z.number().int().min(0).max(336).default(48),
  filters: filtersBody.default(DEFAULT_FILTERS),
});

/**
 * A message variant.
 *
 * `imagePath` is deliberately absent: the DM composer cannot attach an image
 * yet (see orchestrator.doDm), and offering the field would promise something
 * the runner does not do. The column, the store and the media cleanup's
 * protection for it all stay, so wiring it up later needs no migration.
 */
const variantBody = z.object({
  campaignId: z.number().int().positive(),
  text: z.string().trim().min(1).max(1000),
  weight: z.number().int().min(1).max(100).default(1),
  active: z.boolean().default(true),
});

const settingsBody = z.object({
  dailyFollowCap: z.number().int().min(0).max(200),
  dailyDmCap: z.number().int().min(0).max(200),
  dailyProfileVisitCap: z.number().int().min(0).max(1000),
  minGapMinutes: z.number().int().min(0).max(240),
  maxGapMinutes: z.number().int().min(0).max(240),
  activeHourStart: z.number().int().min(0).max(23),
  activeHourEnd: z.number().int().min(1).max(24),
  timezone: z.string().min(1),
  followBackDmMinMinutes: z.number().int().min(0).max(1440),
  followBackDmMaxMinutes: z.number().int().min(0).max(1440),
  maxAttempts: z.number().int().min(1).max(10),
  mode: z.enum(['assisted', 'auto']),
}).partial();

const leadQuery = z.object({
  campaignId: z.coerce.number().int().positive().optional(),
  status: z.enum(['new', 'skipped', 'followed', 'messaged', 'replied', 'opted_out', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export interface IgRouteOptions {
  /** The app-wide job runner, shared with every other module. */
  jobs?: JobRunner;
}

export function registerIgRoutes(app: FastifyInstance, store: IgStore, opts: IgRouteOptions = {}): void {
  const jobs = opts.jobs ?? createJobRunner();

  // --- campaigns -------------------------------------------------------------
  app.get('/api/ig/campaigns', () => store.campaigns.list());

  app.post('/api/ig/campaigns', (req) => store.campaigns.create(parseBody(campaignBody, req)));

  app.patch('/api/ig/campaigns/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.campaigns.get(id), 'campaign');
    return store.campaigns.update(id, parseBody(campaignBody.partial(), req));
  });

  // Refused by the store once any lead references it: the leads table is the
  // contacted registry, and losing it would let someone be approached twice.
  // That refusal is the human asking for something that cannot be done, not a
  // fault, so it comes back as a 400 with the store's own explanation.
  app.delete('/api/ig/campaigns/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.campaigns.get(id), 'campaign');
    try {
      store.campaigns.remove(id);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  });

  // --- message variants ------------------------------------------------------
  app.get('/api/ig/variants', (req) => {
    const { campaignId } = parseQuery(z.object({
      campaignId: z.coerce.number().int().positive().optional(),
    }), req);
    return store.variants.list(campaignId === undefined ? {} : { campaignId });
  });

  /** A typo in a placeholder would go out as literal braces. */
  const checkPlaceholders = (text: string) => {
    const unknown = unknownPlaceholders(text);
    if (unknown.length > 0) {
      throw badRequest(
        `unknown placeholder(s): ${unknown.map((p) => `{${p}}`).join(', ')}`
        + ' — only {first_name} and {username} are filled in',
      );
    }
  };

  app.post('/api/ig/variants', (req) => {
    const body = parseBody(variantBody, req);
    must(store.campaigns.get(body.campaignId), 'campaign');
    checkPlaceholders(body.text);
    return store.variants.create({ ...body, imagePath: null });
  });

  app.patch('/api/ig/variants/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.variants.get(id), 'message');
    const patch = parseBody(variantBody.partial().omit({ campaignId: true }), req);
    if (patch.text !== undefined) checkPlaceholders(patch.text);
    return store.variants.update(id, patch);
  });

  app.delete('/api/ig/variants/:id', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.variants.get(id), 'message');
    store.variants.remove(id);
    return { ok: true };
  });

  // --- leads -----------------------------------------------------------------
  app.get('/api/ig/leads', (req) => {
    const q = parseQuery(leadQuery, req);
    return store.leads.list({
      ...(q.campaignId === undefined ? {} : { campaignId: q.campaignId }),
      ...(q.status === undefined ? {} : { status: q.status }),
      limit: q.limit,
    });
  });

  app.get('/api/ig/leads/counts', (req) => {
    const { campaignId } = parseQuery(z.object({
      campaignId: z.coerce.number().int().positive().optional(),
    }), req);
    return store.leads.countByStatus(campaignId);
  });

  /**
   * Bulk skip, for a human looking at the list and recognising the ones worth
   * not bothering. A lead already contacted is left alone: `messaged` means
   * someone has had a message from us, and pretending otherwise would hide
   * that from the next campaign.
   */
  app.post('/api/ig/leads/skip', (req) => {
    const { ids, reason } = parseBody(z.object({
      ids: z.array(z.number().int().positive()).min(1).max(1000),
      reason: z.string().trim().min(1).max(200).default('skipped by hand'),
    }), req);

    let skipped = 0;
    for (const id of ids) {
      const lead = store.leads.get(id);
      if (!lead || lead.status !== 'new') continue;
      store.leads.update(id, { status: 'skipped', skipReason: reason });
      skipped++;
    }
    return { skipped, requested: ids.length };
  });

  /**
   * Never contact again. Allowed from any status, because a human saying so
   * always wins — and the lead row stays, so the username is never harvested
   * afresh by another campaign.
   */
  app.post('/api/ig/leads/:id/opt-out', (req) => {
    const { id } = parseParams(idParam, req);
    must(store.leads.get(id), 'lead');
    const { reason } = parseBody(z.object({
      reason: z.string().trim().max(200).default('opted out by hand'),
    }), req);
    return store.leads.update(id, { status: 'opted_out', skipReason: reason });
  });

  // --- settings and safety ---------------------------------------------------
  app.get('/api/ig/settings', () => store.settings.get());

  app.patch('/api/ig/settings', (req) => store.settings.update(parseBody(settingsBody, req)));

  /**
   * Clearing the breaker is a human saying "I have looked, and it is safe".
   * It is never cleared automatically: the whole value of a sticky breaker is
   * that something stays stopped until a person decides otherwise.
   */
  app.post('/api/ig/settings/clear-breaker', () => store.settings.clearBreaker());

  app.get('/api/ig/actions', (req) => {
    const { limit } = parseQuery(z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req);
    return store.actions.list({ limit });
  });

  /**
   * The dry run: exactly what a run would do, without doing any of it. The
   * planner is seeded, so this is the plan that runs.
   */
  app.get('/api/ig/plan', () => planNow(store, new Date()));

  // --- jobs ------------------------------------------------------------------

  /**
   * Ask the human to sign in, through the UI.
   *
   * Asked rather than detected, for the same reason as on the Facebook side:
   * Instagram's two-factor and challenge screens differ by account and
   * region, and every attempt to recognise them automatically has been a
   * guess that failed on the real one.
   */
  const askSignIn = (h: JobHandle, cancelLabel: string) => async () => (await h.ask(
    'Sign in to Instagram in the Chrome window that just opened — including any code or '
    + 'phone approval. The browser stays open and nothing happens until you press continue.',
    [
      { value: 'ok', label: 'I am signed in — continue' },
      { value: 'cancel', label: cancelLabel },
    ],
    { kind: 'ig-sign-in' },
  )) === 'ok';

  /** Assisted mode's "I did it / skip / stop" question, through the UI. */
  const askHumanVia = (h: JobHandle, onStop: () => void) =>
    async (_prompt: string, context?: Record<string, unknown>) => {
      const isDm = context !== undefined && 'message' in context;
      const answer = await h.ask(
        isDm
          ? 'Read the message in the browser, then send it yourself and tell me what happened.'
          : 'Have a look at this profile, then tell me what to do.',
        isDm
          ? [
            { value: '', label: 'I sent it' },
            { value: 's', label: 'Skip this lead' },
            { value: 'q', label: 'Stop the run' },
          ]
          : [
            { value: '', label: 'Follow them' },
            { value: 's', label: 'Skip this lead' },
            { value: 'q', label: 'Stop the run' },
          ],
        context,
      );
      if (answer === 'q') onStop();
      return answer;
    };

  const runnerFor = (h: JobHandle, mode: 'assisted' | 'auto', onStop: () => void, stopped: () => boolean) =>
    createIgRunner({
      log: h.log,
      mode,
      cancelled: () => stopped() || h.cancelled,
      confirmSignIn: askSignIn(h, 'Cancel'),
      // Auto mode asks nothing; the runner only calls this when mode is
      // assisted, but passing it unconditionally would be misleading.
      ...(mode === 'assisted' ? { askHuman: askHumanVia(h, onStop) } : {}),
    });

  /** Collect only. Follows nobody, sends nothing — safe to run first. */
  app.post('/api/ig/jobs/harvest', (req) => {
    const { campaignId } = parseBody(z.object({
      campaignId: z.number().int().positive().optional(),
    }), req);
    if (campaignId !== undefined) must(store.campaigns.get(campaignId), 'campaign');

    return jobs.start('ig-harvest', async (h) => {
      h.log('Opening Chrome to collect leads. Nothing will be followed or messaged.');
      let stopped = false;
      const runner = runnerFor(h, 'assisted', () => { stopped = true; }, () => stopped);
      try {
        return await harvestIg({
          store, runner, log: h.log, cancelled: () => stopped || h.cancelled,
        }, campaignId === undefined ? {} : { campaignId });
      } finally {
        await runner.stop();
      }
    }, IG_LANE);
  });

  /** Read our followers and our inbox. Changes lead state, contacts nobody. */
  app.post('/api/ig/jobs/check', () => jobs.start('ig-check', async (h) => {
    h.log('Checking for follow-backs and replies.');
    let stopped = false;
    const runner = runnerFor(h, 'assisted', () => { stopped = true; }, () => stopped);
    try {
      return await checkIg({ store, runner, log: h.log, cancelled: () => stopped || h.cancelled });
    } finally {
      await runner.stop();
    }
  }, IG_LANE));

  /**
   * The real thing: follow and message, within the caps. Runs in whichever
   * mode the settings say — assisted asks before every action.
   */
  app.post('/api/ig/jobs/run', (req) => {
    const { maxSteps } = parseBody(z.object({
      maxSteps: z.number().int().min(1).max(500).optional(),
    }), req);
    const mode = store.settings.get().mode;

    return jobs.start('ig-run', async (h) => {
      h.log(mode === 'auto'
        ? 'Running in AUTO mode: follows and messages go out without asking.'
        : 'Running in assisted mode: you approve every follow and send every message yourself.');
      let stopped = false;
      const runner = runnerFor(h, mode, () => { stopped = true; }, () => stopped);
      try {
        return await runIg({
          store, runner, log: h.log, cancelled: () => stopped || h.cancelled,
        }, maxSteps === undefined ? {} : { maxSteps });
      } finally {
        await runner.stop();
      }
    }, IG_LANE);
  });
}
