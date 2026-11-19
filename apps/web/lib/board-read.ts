/**
 * What the pages read from the board (lib/board.ts): the open tasks, the finished ones newest first, the fleet with what each worker is on,
 * and the plan meters the workers report. There is no task index in the database: the board is the record, and a
 * page asks it.
 */
import { board, WORKER_LANES } from "@relay/core";
import { siteBoard, siteWorkers } from "./board.ts";
import { composeMeters } from "./meters.ts";
import { dataMode } from "./mode.ts";
import { claimProfile } from "./tasks.ts";
import type { PlanMeter } from "./types.ts";

/** The lanes a requeue offers first: the ones `relay work` serves, and `any`. */
export const BUILTIN_LANES: readonly string[] = [...WORKER_LANES, board.ANY_LANE];

/** The most open tasks one read takes: far more than a board in use holds at once. */
const OPEN_MAX = 1000;

/** Newest first: the board lists a queue oldest first, the order it is worked in; a person reads it the other way. */
const newestFirst = (tasks: board.BoardTask[]): board.BoardTask[] => [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id, "en", { numeric: true }));

/** The tasks that are not finished (one project's with `project`), newest first: the board's working columns. A name that is no project slug has no queue. */
export async function openTasks(project?: string): Promise<board.BoardTask[]> {
  if (project && !board.PROJECT_SLUG.test(project)) return [];
  const session = await siteBoard();
  return newestFirst(await board.listTasks(session.board, { state: "open", limit: OPEN_MAX, ...(project ? { project } : {}) }));
}

/**
 * Tasks by latest activity, newest first (core's `recentTasks`): the Done column and History. One project pages back
 * through everything with `older`; across projects it is the newest `limit` and `older` is null.
 */
export async function recentTasks(opts: board.RecentTasksOptions = {}): Promise<{ tasks: board.BoardTask[]; older: string | null }> {
  if (opts.project && !board.PROJECT_SLUG.test(opts.project)) return { tasks: [], older: null };
  return board.recentTasks((await siteBoard()).board, opts);
}

declare global {
  // eslint-disable-next-line no-var
  var __relayFinished: Map<string, { at: number; read: Promise<board.BoardTask[]> }> | undefined;
}
const FINISHED_TTL_MS = 20_000;

/**
 * The newest finished tasks for the board's Done column, read at most once every 20 seconds per instance and
 * project: the board page re-renders that often for everyone looking at it, and across projects the read is one
 * request per queue. A finished task takes that long to show; the columns that need a decision are never cached.
 */
export function newestFinished(limit: number, project?: string, now: number = Date.now()): Promise<board.BoardTask[]> {
  const cache = (globalThis.__relayFinished ??= new Map());
  const key = `${project ?? ""}:${limit}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < FINISHED_TTL_MS) return hit.read;
  const read = recentTasks({ states: ["done", "closed"], limit, ...(project ? { project } : {}) }).then(
    (r) => r.tasks,
    (e: unknown) => {
      if (cache.get(key)?.read === read) cache.delete(key);
      throw e;
    },
  );
  cache.set(key, { at: now, read });
  return read;
}

/** How many tasks wait for a person: in review, and held by the gate. Both are holds on the board, so it is one read of what is held. */
export async function waitingOnYou(): Promise<{ review: number; held: number }> {
  const session = await siteBoard();
  const waiting = await board.listTasks(session.board, { state: ["review", "held"], limit: 400 });
  return { review: waiting.filter((t) => t.state === "review").length, held: waiting.filter((t) => t.state === "held").length };
}

/** The worker whose lane profile holds a claim (`relay-<worker>-<lane>`), or undefined for a claim nobody here made. */
export function workerOfClaim(workers: readonly board.WorkerView[], claim: board.BoardTask["claim"]): board.WorkerView | undefined {
  if (!claim) return undefined;
  const profile = claimProfile(claim.actor);
  return workers.find((w) => w.lanes.some((lane) => board.workerProfile(w.name, lane) === profile));
}

export interface FleetWorker extends board.WorkerView {
  /** The tasks its lanes hold right now. */
  current: board.BoardTask[];
}

/** Every worker with the tasks it is running, most recently seen first. */
export async function fleet(): Promise<FleetWorker[]> {
  const session = await siteBoard();
  const [workers, running] = await Promise.all([siteWorkers(), board.listTasks(session.board, { state: "running", limit: 200 })]);
  return workers.map((w) => ({ ...w, current: running.filter((t) => workerOfClaim([w], t.claim)) })).sort((a, z) => z.last_seen.localeCompare(a.last_seen));
}

/**
 * The plan meters for the header and /usage (lib/meters.ts): RELAY_PLAN_METERS, then the freshest reading in the
 * workers' own messages. The header asks on every page, so a board that cannot be read is no reading, never an error.
 * The demo board's readings are marked as demo numbers.
 */
export async function planMeters(now: number = Date.now()): Promise<PlanMeter[]> {
  const workers = await siteWorkers(now).catch(() => [] as board.WorkerView[]);
  if (dataMode() === "db") return composeMeters({ override: process.env.RELAY_PLAN_METERS, workers, now });
  return composeMeters({ workers, now }).map((m) => (m.source === "vendor" ? { ...m, source: "demo" } : m));
}
