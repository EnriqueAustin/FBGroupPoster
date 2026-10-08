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
/** Namespaced per module, e.g. 'bootstrap', 'post-run', 'ig-campaign'. */
export type JobKind = string;

/** A question the job is blocked on, surfaced to the UI. */
export interface JobPrompt {
  id: string;
  question: string;
  options: { value: string; label: string }[];
  /** Context so the UI can show what is being decided. */
  context?: Record<string, unknown>;
}

/**
 * Which browser a job drives. Jobs in different lanes run side by side; a
 * second job in a busy lane is refused. A lane is one identity, because each
 * identity has its own Chrome profile (see profileDirFor) and a profile can
 * only be open once.
 */
export interface JobLane {
  key: string;
  /** Shown in the UI so two running jobs can be told apart. */
  label: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  lane: string;
  label: string;
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

  /**
   * One job per lane — two Chrome instances on one profile corrupt it, and two
   * posting runs in one lane would blow through that identity's daily cap. A
   * lane is one Chrome profile: each Facebook identity has one, and Instagram
   * has its own, so IG work can run beside a Facebook round.
   */
  const activeLanes = new Map<string, JobKind>();

  const DEFAULT_LANE: JobLane = { key: 'default', label: '' };

  function start(kind: JobKind, fn: (h: JobHandle) => Promise<unknown>, lane: JobLane = DEFAULT_LANE): Job {
    const busy = activeLanes.get(lane.key);
    if (busy) {
      throw new Error(`another job (${busy}${lane.label ? ` as ${lane.label}` : ''}) is already running — stop it first`);
    }
    const id = `job-${++counter}-${Date.now().toString(36)}`;
    const job: Job = {
      id, kind, lane: lane.key, label: lane.label, status: 'running', lines: [], startedAt: new Date().toISOString(),
      endedAt: null, error: null, result: null, awaiting: null,
    };
    jobs.set(id, job);
    activeLanes.set(lane.key, kind);

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
        activeLanes.delete(lane.key);
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
    /** Every running job, oldest first — one per busy lane. */
    running: () => [...jobs.values()].filter((j) => j.status === 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    laneBusy: (key: string) => activeLanes.has(key),
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
