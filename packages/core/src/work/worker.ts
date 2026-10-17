/**
 * The worker loop behind `relay work` (docs/WORKERS.md, "The loop"): register, then on every tick read the doorbell
 * (the queue version and a queued estimate, one cheap query) and run a claim only when the version moved since the
 * last read or something is queued. The tick starts at `pollMs` (15 s) after any activity and doubles while nothing
 * happens, up to `maxIdleMs` (5 minutes), so an idle worker makes a few hundred requests a day instead of several
 * thousand and a Neon database behind the site is left alone. A claimed task runs, and when it finishes the loop
 * claims once more right away (there may be more work) before going back to the doorbell. Heartbeats go every
 * minute while a lease is held (they renew it) and at most every `idleHeartbeatMs` otherwise, carrying the current
 * interval so the workers page can show it, and the plan meters relay's status line saved under ~/.harness/meters
 * (`meters.ts`), so the site's header can show the login's own 5-hour and 7-day usage. One job at a time by default;
 * `jobs` raises it, and the lane adapters' per-subscription locks still keep one process per vendor login. A stop
 * (SIGTERM, --once with an empty queue) lets running jobs finish, then reports the worker offline.
 */
import type { WorkerRow } from "../db/workers.ts";
import { relayHome } from "../hooks/cache.ts";
import { readMeterFiles, type MeterReading } from "../meters.ts";
import { type Log, noopLog } from "../util.ts";
import type { WorkApi } from "./api.ts";
import { runJob, type JobOptions, type JobResult } from "./job.ts";
import type { ClaimResult } from "./server.ts";

/** Heartbeat cadence while this worker holds a lease (each one renews the lease). */
export const HEARTBEAT_MS = 60_000;
/** The tick right after activity; the loop doubles it while idle. */
export const POLL_MS = 15_000;
/** The longest an idle worker waits between doorbell reads (`--max-interval`, `RELAY_WORK_MAX_INTERVAL`). */
export const MAX_IDLE_MS = 5 * 60_000;
/** Heartbeat cadence while idle: enough for the workers page to show `idle`, not `offline` (WORKER_OFFLINE_MS is an hour). */
export const IDLE_HEARTBEAT_MS = 5 * 60_000;

export interface WorkerLoopOptions {
  api: WorkApi;
  name: string;
  host: string;
  lanes: string[];
  labels?: string[];
  version: string;
  /** Concurrent jobs (default 1). */
  jobs?: number;
  /** Drain the queue once, then stop (no doorbell, no sleep between claims). */
  once?: boolean;
  /** The first idle tick (default 15 s); the loop doubles it up to maxIdleMs. */
  pollMs?: number;
  /** The longest idle tick (default 5 minutes; never below pollMs). */
  maxIdleMs?: number;
  heartbeatMs?: number;
  idleHeartbeatMs?: number;
  log?: Log;
  /** Interval and version changes, for `RELAY_DEBUG`; silent by default. */
  debug?: Log;
  /** Per-job settings (git host, lane runner, timeout, keep) passed through to runJob. */
  job?: Omit<JobOptions, "api" | "workerId" | "workerName" | "host">;
  signal?: AbortSignal;
  onJob?: (r: JobResult) => void;
  /** Called with the interval after every change (tests, status displays). */
  onInterval?: (ms: number) => void;
  /** The job runner (`runJob`); the loop tests substitute one that does no git. */
  runJob?: (claim: ClaimResult, opts: JobOptions) => Promise<JobResult>;
  /** The plan meters to send with each heartbeat (default: the fresh files under `$RELAY_HOME/meters`). */
  meters?: () => MeterReading[];
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

const secs = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

export async function runWorker(opts: WorkerLoopOptions): Promise<WorkerLoopResult> {
  const log = opts.log ?? noopLog;
  const debug = opts.debug ?? noopLog;
  const jobs = Math.max(1, opts.jobs ?? 1);
  const pollMs = Math.max(1, opts.pollMs ?? POLL_MS);
  const maxIdleMs = Math.max(pollMs, opts.maxIdleMs ?? MAX_IDLE_MS);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const idleHeartbeatMs = Math.max(heartbeatMs, opts.idleHeartbeatMs ?? IDLE_HEARTBEAT_MS);
  const lanes = opts.lanes;
  const labels = opts.labels ?? [];
  const { worker } = await opts.api.register({ name: opts.name, host: opts.host, lanes, labels, version: opts.version });
  log(`registered as ${worker.name} (${worker.id}) serving ${worker.lanes.join(", ") || "no lanes"}${worker.labels.length ? ` with labels ${worker.labels.join(", ")}` : ""} via ${opts.api.mode}`);
  const results: JobResult[] = [];
  const running = new Set<Promise<void>>();
  let stopped = false;
  let interval = pollMs;
  /** The queue version seen by the last doorbell read; a claim runs when the next read differs. */
  let lastVersion: number | undefined;
  /** Claim on the next pass whatever the doorbell says: at start, after a claim, and when a job finishes. */
  let claimNow = true;
  const run = opts.runJob ?? runJob;
  const readMeters = opts.meters ?? (() => readMeterFiles(relayHome()));
  /** Never let a bad meter file cost a heartbeat. */
  const meters = (): MeterReading[] => {
    try {
      return readMeters();
    } catch {
      return [];
    }
  };
  let lastBeat = Date.now();
  let beating: Promise<void> | undefined;

  const setIntervalTo = (ms: number) => {
    if (ms === interval) return;
    debug(`poll interval ${secs(interval)} -> ${secs(ms)}`);
    interval = ms;
    opts.onInterval?.(ms);
  };
  const beat = (): Promise<void> => {
    if (beating) return beating;
    lastBeat = Date.now();
    beating = opts.api
      .heartbeat(worker.id, { interval_ms: interval, meters: meters() })
      .then(() => undefined)
      .catch((e: unknown) => log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (beating = undefined));
    return beating;
  };
  /** Every minute while a lease is held; otherwise only when the idle cadence is due. */
  const maybeBeat = (): Promise<void> | undefined => (running.size > 0 || Date.now() - lastBeat >= idleHeartbeatMs ? beat() : undefined);
  const timer = setInterval(() => void maybeBeat(), heartbeatMs);
  /** An empty tick: wait the current interval, then lengthen it. */
  const rest = async () => {
    await abortable(interval, opts.signal);
    if (!stopped) setIntervalTo(Math.min(interval * 2, maxIdleMs));
  };
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
      // Every tick reads the doorbell (one cheap query) so the remembered version is current even right after this
      // worker's own release moved it; --once drains with claims alone.
      let shouldClaim = opts.once === true;
      if (!opts.once) {
        let bell;
        try {
          bell = await opts.api.doorbell({ lanes });
        } catch (e) {
          log(`doorbell failed: ${e instanceof Error ? e.message : String(e)}`);
          await rest();
          continue;
        }
        await maybeBeat();
        if (!bell) {
          shouldClaim = true; // the site has no doorbell: claim on every tick, still backing off
        } else {
          const moved = bell.version !== lastVersion;
          if (moved) debug(`queue version ${lastVersion ?? "?"} -> ${bell.version}${bell.queued ? `, ${bell.queued} queued` : ""}`);
          lastVersion = bell.version;
          shouldClaim = claimNow || moved || bell.queued > 0;
        }
        if (!shouldClaim) {
          await rest();
          continue;
        }
      }
      claimNow = false;
      let claim;
      try {
        claim = await opts.api.claim({ worker_id: worker.id, lanes, labels });
      } catch (e) {
        log(`claim failed: ${e instanceof Error ? e.message : String(e)}`);
        if (opts.once) break;
        await rest();
        continue;
      }
      if (!claim) {
        if (opts.once) break;
        await rest();
        continue;
      }
      setIntervalTo(pollMs);
      log(`claimed ${claim.task.id} (${claim.task.lane}) until ${claim.claim.lease_until}`);
      const p = run(claim, { ...(opts.job ?? {}), api: opts.api, workerId: worker.id, workerName: worker.name, host: opts.host, log })
        .then((r) => {
          results.push(r);
          opts.onJob?.(r);
        })
        .catch((e: unknown) => log(`${claim!.task.id}: report failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          running.delete(p);
          claimNow = true; // the queue may hold more: one claim right away, then back to the doorbell
          setIntervalTo(pollMs);
        });
      running.add(p);
      claimNow = true;
    }
    await Promise.all(running);
  } finally {
    clearInterval(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    await beating?.catch(() => {});
    try {
      await opts.api.heartbeat(worker.id, { status: "offline", interval_ms: interval, meters: meters() });
    } catch {
      /* the site will see the silence */
    }
  }
  return { worker, ran: results.length, results };
}
