/**
 * Generic job endpoints: list, poll, answer, stop.
 *
 * Every module starts its own jobs (FB bootstrap, FB posting, IG campaigns…)
 * through the one shared JobRunner, so the UI polls a single set of endpoints
 * whichever module is driving the browser.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { must, parseBody } from './http.ts';
import type { JobRunner } from './jobs.ts';

export function registerJobRoutes(app: FastifyInstance, jobs: JobRunner): void {
  app.get('/api/jobs', () => jobs.list().map((j) => ({ ...j, lines: j.lines.slice(-5) })));
  app.get('/api/jobs/current', () => jobs.current());
  app.get('/api/jobs/:id', (req) => {
    const id = String((req.params as { id: string }).id);
    return must(jobs.get(id), 'job');
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
}
