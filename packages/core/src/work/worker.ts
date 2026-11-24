/**
 * The worker loop behind `relay work` (docs/WORKERS.md, "The loop"). The queue is the board: every project's tasks
 * are threads under `work/`, and a task is this worker's to take when its `lane` label names a lane the machine
 * serves (or `any`, for a code lane) and its owner is one the machine takes work from.
 *
 *   look     one claim per free lane, oldest ready task first; the board gives the task to exactly one claimer
 *   run      the job renews its own lease; one job at a time by default (`jobs` raises it, never two on one lane,
 *            since a lane is one vendor login)
 *   wait     with nothing to take, the loop blocks on the board until a task under `work/` becomes ready, from a
 *            cursor it noted before it looked, so nothing that happened in between is missed. It never polls on a
 *            timer; the wait ends by itself every few minutes so a lease that ran out elsewhere is found too
 *   live     the worker's message in `relay/workers` is relabelled on every pass and every few minutes while a job
 *            runs, and rewritten when the plan meters relay's status line saved under ~/.harness/meters change
 *
 * A stop (SIGTERM, `--once` with nothing left) lets running jobs finish, then marks the worker offline.
 */
import { BoardError, type Board, type ClaimedTask } from "@vercel/board";
import { describeBoardError, type BoardSession } from "../board/client.ts";
import { ANY_LANE, LABEL, WORK_SUBTREE, workerProfile } from "../board/mapping.ts";
import { ensureSchemas } from "../board/schemas.ts";
import { registerWorker, type WorkerRegistration } from "../board/workers.ts";
import { relayHome } from "../hooks/cache.ts";
import { readMeterFiles, type MeterReading } from "../meters.ts";
import { isCodeLane } from "../tasks/lanes.ts";
import { type Log, noopLog } from "../util.ts";
import { runJob, type JobOptions, type JobResult } from "./job.ts";

/** How long an idle worker waits on the board before it looks again by itself. */
export const IDLE_WAIT_MS = 5 * 60_000;
/** How often a worker with a job running says it is alive. */
export const HEARTBEAT_MS = 5 * 60_000;
/** The pause after a failed look (the board unreachable, a rate limit), doubled up to IDLE_WAIT_MS. */
export const RETRY_MS = 15_000;

export interface WorkerLoopOptions {
  session: BoardSession;
  name: string;
  host: string;
  lanes: string[];
  labels?: string[];
  version: string;
  /** Concurrent jobs (default 1), each on a different lane. */
  jobs?: number;
  /** Drain the queue once, then stop (no waiting). */
  once?: boolean;
  /** Run this one task and stop: a sandbox started for a task someone approved. Its owner must still be one this worker takes tasks from. */
  only?: string;
  idleWaitMs?: number;
  heartbeatMs?: number;
  retryMs?: number;
  log?: Log;
  /** What the loop is waiting for and why it woke, for `RELAY_DEBUG`; silent by default. */
  debug?: Log;
  /** Per-job settings (git host, lane runner, timeout, keep) passed through to runJob. */
  job?: Omit<JobOptions, "board" | "lane" | "workerName" | "trusted">;
  signal?: AbortSignal;
  onJob?: (r: JobResult) => void;
  /** The job runner (`runJob`); the loop tests substitute one that does no git. */
  runJob?: (claim: ClaimedTask, opts: JobOptions) => Promise<JobResult>;
  /** The plan meters to post (default: the fresh files under `$RELAY_HOME/meters`). */
  meters?: () => MeterReading[];
}

export interface WorkerLoopResult {
  /** The worker's message in `relay/workers`. */
  thread: string;
  ran: number;
  results: JobResult[];
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
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

/** What a failed claim means for the operator, where the board's own words need relay's context. */
function claimAdvice(e: unknown): string {
  const said = describeBoardError(e);
  if (e instanceof BoardError && (e.code === "claim_too_wide" || e.code === "channel_tree_too_large")) return `${said} A claim looks under ${WORK_SUBTREE} for every owner in board.from: name fewer owners in ~/.harness/config.json.`;
  if (e instanceof BoardError && e.code === "not_logged_in") return `${said} The worker reaches the board with this machine's own Vercel login: run vercel login here.`;
  return said;
}

export async function runWorker(opts: WorkerLoopOptions): Promise<WorkerLoopResult> {
  const log = opts.log ?? noopLog;
  const debug = opts.debug ?? noopLog;
  const { board, me, from } = opts.session;
  const jobs = Math.max(1, opts.jobs ?? 1);
  const idleWaitMs = Math.max(1, opts.idleWaitMs ?? IDLE_WAIT_MS);
  const heartbeatMs = Math.max(1, opts.heartbeatMs ?? HEARTBEAT_MS);
  const retryMs = Math.max(1, opts.retryMs ?? RETRY_MS);
  const lanes = opts.lanes;
  const info = { name: opts.name, host: opts.host, lanes, labels: opts.labels ?? [], version: opts.version };
  const run = opts.runJob ?? runJob;
  const readMeters = opts.meters ?? (() => readMeterFiles(relayHome()));
  /** Never let a bad meter file cost a sign of life. */
  const meters = (): MeterReading[] => {
    try {
      return readMeters();
    } catch {
      return [];
    }
  };
  /** One handle per lane: the board shows `relay-<worker>-<lane> via <login>`, and a lane's claims are its own. */
  const handles = new Map<string, Board>();
  const handle = (lane: string): Board => {
    let h = handles.get(lane);
    if (!h) handles.set(lane, (h = board.as(workerProfile(opts.name, lane))));
    return h;
  };

  // a job reports in blocks, and the worker's own message is one: without the schemas nothing it does would land
  if (!(await ensureSchemas(board))) throw new Error("relay's schemas are not on this board and this login cannot register them (it takes `manage` everywhere). Someone who manages the board runs once: relay setup --board");
  const reg: WorkerRegistration = await registerWorker(board, info, meters());
  log(`on the board as ${me.handle} (${me.principal}), worker ${opts.name} serving ${lanes.join(", ") || "no lanes"}${info.labels.length ? ` with labels ${info.labels.join(", ")}` : ""}; taking tasks from ${from.join(", ")}`);

  // what a run leaves in a thread is trusted by its author; on a board where a profile is a principal of its own
  // (a local one), this worker's lane profiles would otherwise read as strangers to each other
  const trusted = [...new Set([...from, ...(await Promise.all(lanes.map((l) => handle(l).me()))).map((m) => m.actor)])];
  const results: JobResult[] = [];
  const once = !!opts.once || !!opts.only;
  const running = new Map<Promise<void>, string>();
  let stopped = false;
  let retry = retryMs;
  let lastBeat = Date.now();
  const beat = async (): Promise<void> => {
    lastBeat = Date.now();
    await reg.beat({ running: running.size, meters: meters() }).catch((e: unknown) => log(`could not update the worker's message: ${describeBoardError(e)}`));
  };
  const timer = setInterval(() => {
    if (running.size > 0 && Date.now() - lastBeat >= heartbeatMs) void beat();
  }, Math.min(heartbeatMs, 60_000));
  timer.unref?.();
  const onAbort = () => {
    stopped = true;
    log("stopping: no new claims; waiting for running jobs");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  /** The oldest ready task this worker may take on a lane that is free: its own lanes first, then `any` on a free code lane. */
  let took = false;
  const claimNext = async (): Promise<{ claim: ClaimedTask; lane: string } | undefined> => {
    if (opts.only) {
      if (took) return undefined;
      took = true;
      const root = (await board.thread(opts.only)).message;
      // a claim by ID asks nobody whose task it is, so the worker's own rule is checked here
      if (!root.task || !from.includes(root.task.owner)) throw new Error(`${opts.only} is not a task of an owner this worker takes tasks from`);
      const want = root.labels?.[LABEL.lane];
      const lane = want === ANY_LANE ? lanes.find(isCodeLane) : lanes.find((l) => l === want);
      if (!lane) throw new Error(`this worker does not serve the lane of ${opts.only} (${want ?? "none"})`);
      return { claim: await handle(lane).tasks.claim(opts.only), lane };
    }
    const busy = new Set(running.values());
    const free = lanes.filter((l) => !busy.has(l));
    for (const lane of free) {
      const claim = await handle(lane).tasks.claim({ channel: WORK_SUBTREE, label: { [LABEL.lane]: lane }, from });
      if (claim) return { claim, lane };
    }
    const code = free.find(isCodeLane);
    if (code) {
      const claim = await handle(code).tasks.claim({ channel: WORK_SUBTREE, label: { [LABEL.lane]: ANY_LANE }, from });
      if (claim) return { claim, lane: code };
    }
    return undefined;
  };

  try {
    while (!stopped) {
      if (running.size >= jobs) {
        await Promise.race(running.keys());
        continue;
      }
      let cursor: string | undefined;
      let next: { claim: ClaimedTask; lane: string } | undefined;
      try {
        // note the place before looking: a task that becomes ready while this pass looks still wakes the wait below
        if (!once) cursor = (await board.poll({ channel: WORK_SUBTREE, wait: 0 })).cursor;
        next = await claimNext();
        retry = retryMs;
      } catch (e) {
        log(`could not look for work: ${claimAdvice(e)}`);
        if (once) break;
        await sleep(retry, opts.signal);
        retry = Math.min(retry * 2, idleWaitMs);
        continue;
      }
      if (!next) {
        if (once) break;
        await beat();
        debug(`nothing to take; waiting on ${WORK_SUBTREE} for up to ${Math.round(idleWaitMs / 1000)}s`);
        try {
          const woke = await board.wait({ channel: WORK_SUBTREE, label: ["board.task=ready"], ...(cursor ? { after: cursor } : {}) }, { timeout: idleWaitMs, ...(opts.signal ? { signal: opts.signal } : {}) });
          debug(woke ? `woke on ${woke.type} ${woke.message?.id ?? ""}` : "the wait ended; looking again");
        } catch (e) {
          if (stopped) break;
          log(`the wait on the board failed: ${describeBoardError(e)}`);
          await sleep(retry, opts.signal);
          retry = Math.min(retry * 2, idleWaitMs);
        }
        continue;
      }
      const { claim, lane } = next;
      log(`claimed ${claim.task.id} for the ${lane} lane until ${claim.until}`);
      const p: Promise<void> = run(claim, { ...(opts.job ?? {}), board: handle(lane), lane, workerName: opts.name, trusted, log })
        .then((r) => {
          results.push(r);
          opts.onJob?.(r);
        })
        .catch((e: unknown) => log(`${claim.task.id}: could not report: ${describeBoardError(e)}`))
        .finally(() => running.delete(p));
      running.set(p, lane);
      void beat();
    }
    await Promise.all(running.keys());
  } finally {
    clearInterval(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    await reg.offline(meters()).catch(() => {
      /* the board will see the silence */
    });
  }
  return { thread: reg.id, ran: results.length, results };
}
