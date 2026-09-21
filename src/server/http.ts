/**
 * Small HTTP helpers shared by every route module.
 *
 * Route handlers stay thin: they validate with zod, call the Store, and map the
 * result. Anything that throws an `HttpError` is turned into a JSON error body
 * by the app-level error handler.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, output as ZodOutput } from 'zod';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details ?? null;
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, message, details);

export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`);

/** Flatten a ZodError into `{ "path.to.field": ["message"] }` for the UI. */
export function zodDetails(err: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    const bucket = out[key];
    if (bucket) bucket.push(issue.message);
    else out[key] = [issue.message];
  }
  return out;
}

/**
 * Validate an arbitrary value, raising a 400 with per-field detail on failure.
 *
 * Generic over the SCHEMA rather than over a value type: zod's input and output
 * types diverge as soon as `.default()` is used, and constraining to
 * `ZodType<T>` forces TypeScript to infer the *input* side, which makes every
 * defaulted field look optional to callers.
 */
export function parseOr400<S extends ZodTypeAny>(schema: S, value: unknown, what = 'body'): ZodOutput<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(`Invalid ${what}`, zodDetails(result.error));
  }
  return result.data as ZodOutput<S>;
}

export const parseBody = <S extends ZodTypeAny>(schema: S, req: FastifyRequest): ZodOutput<S> =>
  parseOr400(schema, req.body, 'body');

export const parseQuery = <S extends ZodTypeAny>(schema: S, req: FastifyRequest): ZodOutput<S> =>
  parseOr400(schema, req.query, 'query');

export const parseParams = <S extends ZodTypeAny>(schema: S, req: FastifyRequest): ZodOutput<S> =>
  parseOr400(schema, req.params, 'params');

/** Anything not found / not allowed by the store surfaces as a clean status. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'Invalid request', details: zodDetails(err) });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: message, details: null });
}

/** Require a row the store may not have; keeps handlers to one line. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}
