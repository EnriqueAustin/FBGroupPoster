/**
 * Long-running browser work, driven from the UI.
 *
 * Bootstrapping and posting both take minutes and both need the human, so they
 * cannot be plain request/response. A job runs in the background, streams log
 * lines the UI polls for, and — crucially for assisted posting — can block
 * waiting for an answer that arrives as a later HTTP call.
 *
 * In-memory and single-process on purpose: one user, one machine, and a job
 * that does not survive a restart is correct here rather than unfortunate,
 * because the browser it was driving did not survive either.
 */

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type JobKind = 'bootstrap' | 'post-run';

/** A question the job is blocked on, surfaced to the UI. */
export interface JobPrompt {
  id: string;
  question: string;
  options: { value: string; label: string }[];
  /** Context so the UI can show what is being decided. */
  context?: Record<string, unknown>;
}

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  lines: string[];
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  result: unknown;
  awaiting: JobPrompt | null;
}

interface Pending {
  prompt: JobPrompt;
  resolve: (answer: string) => void;
}

export interface JobHandle {
  log: (msg: string) => void;
  /** Block until the human answers in the UI. */
  ask: (question: string, options: JobPrompt['options'], context?: Record<string, unknown>) => Promise<string>;
  /** True once someone has asked this job to stop. */
  readonly cancelled: boolean;
}

export function createJobRunner() {
  const jobs = new Map<string, Job>();
  const pending = new Map<string, Pending>();
  const cancelling = new Set<string>();
  let counter = 0;

  /** Only one browser job at a time — two Chrome instances on one profile
   *  corrupt it, and two posting runs would blow through the daily cap. */
  const activeKinds = new Set<JobKind>();

  function start(kind: JobKind, fn: (h: JobHandle) => Promise<unknown>): Job {
    if (activeKinds.size > 0) {
      throw new Error(`another job (${[...activeKinds].join(', ')}) is already running`);
    }
    const id = `job-${++counter}-${Date.now().toString(36)}`;
    const job: Job = {
      id, kind, status: 'running', lines: [], startedAt: new Date().toISOString(),
      endedAt: null, error: null, result: null, awaiting: null,
    };
    jobs.set(id, job);
    activeKinds.add(kind);

    const handle: JobHandle = {
      log(msg) {
        // Keep the tail bounded; a long run should not grow without limit.
        job.lines.push(msg);
        if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
      },
      ask(question, options, context) {
        return new Promise<string>((resolve) => {
          const prompt: JobPrompt = {
            id: `${id}-p${job.lines.length}`,
            question,
            options,
            ...(context ? { context } : {}),
          };
          job.awaiting = prompt;
          pending.set(id, { prompt, resolve });
        });
      },
      get cancelled() { return cancelling.has(id); },
    };

    void (async () => {
      try {
        job.result = await fn(handle);
        job.status = cancelling.has(id) ? 'cancelled' : 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        handle.log(`ERROR: ${job.error}`);
      } finally {
        job.endedAt = new Date().toISOString();
        job.awaiting = null;
        pending.delete(id);
        cancelling.delete(id);
        activeKinds.delete(kind);
      }
    })();

    return job;
  }

  function respond(id: string, answer: string): Job {
    const job = jobs.get(id);
    if (!job) throw new Error(`no such job ${id}`);
    const p = pending.get(id);
    if (!p) throw new Error('this job is not waiting for an answer');
    pending.delete(id);
    job.awaiting = null;
    p.resolve(answer);
    return job;
  }

  function cancel(id: string): Job {
    const job = jobs.get(id);
    if (!job) throw new Error(`no such job ${id}`);
    cancelling.add(id);
    // If it is blocked on a question, unblock it with a stop answer so the
    // run loop can wind down cleanly instead of hanging forever.
    const p = pending.get(id);
    if (p) { pending.delete(id); job.awaiting = null; p.resolve('q'); }
    return job;
  }

  return {
    start,
    respond,
    cancel,
    get: (id: string) => jobs.get(id) ?? null,
    list: () => [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    current: () => [...jobs.values()].find((j) => j.status === 'running') ?? null,
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
