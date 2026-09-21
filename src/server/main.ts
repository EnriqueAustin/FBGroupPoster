/**
 * Local control surface.
 *
 * Binds to 127.0.0.1 only. This is a single-user tool with no authentication,
 * and it holds a live Facebook session's worth of leverage — it must never be
 * reachable from the network.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store/sqlite-store.ts';
import { createScheduler } from '../scheduler/planner.ts';
import { registerRoutes, MEDIA_DIR } from './routes.ts';
import { DB_PATH } from '../config.ts';

const HOST = '127.0.0.1';
// Overridable so a second instance can run alongside the real one — pair it
// with FBGP_DB to try something out without touching either the live port or
// the live database. Still 127.0.0.1 only; that part is not negotiable.
const PORT = Number(process.env.FBGP_PORT ?? 8787);

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', 'web');

const store = openStore(DB_PATH);
const scheduler = createScheduler(store);

const app = Fastify({ logger: false });

await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: path.resolve(webRoot), prefix: '/' });
// Uploaded images are served back so the UI can preview them.
await app.register(fastifyStatic, {
  root: path.resolve(MEDIA_DIR),
  prefix: '/media/',
  decorateReply: false,
});

registerRoutes(app, store, scheduler);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: HOST, port: PORT });
console.log(`\n  FB Group Poster — http://${HOST}:${PORT}\n`);
