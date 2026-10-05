/**
 * Local control surface.
 *
 * Binds to 127.0.0.1 only. This is a single-user tool with no authentication,
 * and it holds live Facebook and Instagram sessions' worth of leverage — it
 * must never be reachable from the network.
 *
 * This file is the only place the modules meet: it builds the shared pieces
 * (one job runner, one error handler) and hands them to each module's routes.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '../core/config.ts';
import { installErrorHandler } from '../core/http.ts';
import { createJobRunner } from '../core/jobs.ts';
import { registerJobRoutes } from '../core/job-routes.ts';
import { openStore } from '../facebook/store/sqlite-store.ts';
import { createScheduler } from '../facebook/scheduler/planner.ts';
import { registerRoutes as registerFacebookRoutes, MEDIA_DIR } from '../facebook/routes.ts';
import { openIgStore } from '../instagram/store/sqlite-store.ts';

const HOST = '127.0.0.1';
// Overridable so a second instance can run alongside the real one — pair it
// with FBGP_DB to try something out without touching either the live port or
// the live database. Still 127.0.0.1 only; that part is not negotiable.
const PORT = Number(process.env.FBGP_PORT ?? 8787);

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', 'web');

const store = openStore(DB_PATH);
const scheduler = createScheduler(store);
// Same database file, own tables (ig_*) and own migration history.
const igStore = openIgStore(DB_PATH);
// One runner for every module: only one job may drive the browser at a time.
const jobs = createJobRunner();

const app = Fastify({ logger: false });

await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: path.resolve(webRoot), prefix: '/' });
// Uploaded images are served back so the UI can preview them.
await app.register(fastifyStatic, {
  root: path.resolve(MEDIA_DIR),
  prefix: '/media/',
  decorateReply: false,
});

installErrorHandler(app);
registerJobRoutes(app, jobs);
registerFacebookRoutes(app, store, scheduler, {
  jobs,
  otherReferencedImages: () => igStore.variants.list()
    .map((v) => v.imagePath).filter((p): p is string => p !== null),
});

const shutdown = async () => {
  await app.close();
  store.close();
  igStore.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: HOST, port: PORT });
console.log(`\n  Social Toolkit — http://${HOST}:${PORT}\n`);
