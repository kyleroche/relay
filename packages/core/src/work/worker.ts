/**
 * The worker loop behind `relay work`: register, heartbeat every minute (which renews the leases this worker holds),
 * claim the next task, run it, report, repeat. One job at a time by default; `jobs` raises it, and the lane adapters'
 * per-subscription locks still keep one process per vendor login. A stop (SIGTERM, --once with an empty queue) lets
 * running jobs finish, then reports the worker offline.
 */
import type { WorkerRow } from "../db/workers.ts";
import { sleep, type Log, noopLog } from "../util.ts";
import type { WorkApi } from "./api.ts";
import { runJob, type JobOptions, type JobResult } from "./job.ts";

export const HEARTBEAT_MS = 60_000;
export const POLL_MS = 15_000;

export interface WorkerLoopOptions {
  api: WorkApi;
  name: string;
  host: string;
  lanes: string[];
  labels?: string[];
  version: string;
  /** Concurrent jobs (default 1). */
  jobs?: number;
  /** Drain the queue once, then stop (no sleep between claims). */
  once?: boolean;
  pollMs?: number;
  heartbeatMs?: number;
  log?: Log;
  /** Per-job settings (git host, lane runner, timeout, keep) passed through to runJob. */
  job?: Omit<JobOptions, "api" | "workerId" | "workerName" | "host">;
  signal?: AbortSignal;
  onJob?: (r: JobResult) => void;
}

export interface WorkerLoopResult {
  worker: WorkerRow;
  ran: number;
  results: JobResult[];
}

const abortable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      res();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export async function runWorker(opts: WorkerLoopOptions): Promise<WorkerLoopResult> {
  const log = opts.log ?? noopLog;
  const jobs = Math.max(1, opts.jobs ?? 1);
  const pollMs = opts.pollMs ?? POLL_MS;
  const { worker } = await opts.api.register({ name: opts.name, host: opts.host, lanes: opts.lanes, labels: opts.labels ?? [], version: opts.version });
  log(`registered as ${worker.name} (${worker.id}) serving ${worker.lanes.join(", ") || "no lanes"}${worker.labels.length ? ` with labels ${worker.labels.join(", ")}` : ""} via ${opts.api.mode}`);
  const results: JobResult[] = [];
  const running = new Set<Promise<void>>();
  let stopped = false;
  const beat = async () => {
    try {
      await opts.api.heartbeat(worker.id);
    } catch (e) {
      log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const timer = setInterval(() => void beat(), opts.heartbeatMs ?? HEARTBEAT_MS);
  const onAbort = () => {
    stopped = true;
    log("stopping: no new claims; waiting for running jobs");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!stopped) {
      if (running.size >= jobs) {
        await Promise.race(running);
        continue;
      }
      let claim;
      try {
        claim = await opts.api.claim({ worker_id: worker.id, lanes: opts.lanes, labels: opts.labels ?? [] });
      } catch (e) {
        log(`claim failed: ${e instanceof Error ? e.message : String(e)}`);
        if (opts.once) break;
        await abortable(pollMs, opts.signal);
        continue;
      }
      if (!claim) {
        if (opts.once) break;
        await abortable(pollMs, opts.signal);
        continue;
      }
      log(`claimed ${claim.task.id} (${claim.task.lane}) until ${claim.claim.lease_until}`);
      const p = runJob(claim, { ...(opts.job ?? {}), api: opts.api, workerId: worker.id, workerName: worker.name, host: opts.host, log })
        .then((r) => {
          results.push(r);
          opts.onJob?.(r);
        })
        .catch((e: unknown) => log(`${claim!.task.id}: report failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => running.delete(p));
      running.add(p);
    }
    await Promise.all(running);
  } finally {
    clearInterval(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    try {
      await opts.api.heartbeat(worker.id, { status: "offline" });
    } catch {
      /* the site will see the silence */
    }
  }
  return { worker, ran: results.length, results };
}
