/**
 * The workers of a board, kept on the board itself: one message per machine in `relay/workers`. Its text is a
 * `relay-worker@1` block (what the machine serves, and the plan meters its logins report), rewritten in place when
 * that changes; its labels say when it was last seen and how many jobs it runs. A worker writes its own message;
 * anyone who reads the channel sees the fleet, so `relay work status`, the lane registry and the site's workers page
 * need no table.
 *
 * Posted with `noSync`, so it never reaches Slack or GitHub.
 */
import { type Board, type MessageView } from "@vercel/board";
import type { MeterReading } from "../meters.ts";
import { laneUnservedProblem } from "../tasks/lanes.ts";
import { asTaskError, openTask, TaskError, type BoardTask, type OpenTaskInput } from "./tasks.ts";
import { WORKERS_CHANNEL } from "./mapping.ts";
import { blocksOf, WORKER_SCHEMA, workerText, type WorkerBlock } from "./schemas.ts";

/** Seen within this window, a worker is online: its idle wait on the board is shorter than this. */
export const WORKER_ONLINE_MS = 12 * 60_000;
/** Silent for longer than this (or after a clean stop), it is offline. */
export const WORKER_OFFLINE_MS = 60 * 60_000;
/** Offline for longer than this, it is retired: folded away until `forgetWorker` hides it. */
export const WORKER_RETIRED_MS = 7 * 24 * 60 * 60_000;

export type WorkerState = "online" | "idle" | "offline";

export interface WorkerInfo {
  name: string;
  host: string;
  lanes: string[];
  labels: string[];
  version: string;
}

export interface WorkerView extends WorkerInfo {
  /** The worker's message on the board. */
  id: string;
  /** Who runs it: the login behind its message. */
  by: string;
  last_seen: string;
  state: WorkerState;
  retired: boolean;
  /** How many jobs it said it was running at its last sign of life. */
  running: number;
  meters: MeterReading[];
}

export interface WorkerRegistration {
  /** The worker's message. */
  id: string;
  /** A sign of life: the labels are rewritten, and the block when the meters changed. */
  beat(state: { running: number; meters: MeterReading[] }): Promise<void>;
  /** A clean stop. */
  offline(meters: MeterReading[]): Promise<void>;
}

/**
 * Take (or make) this machine's message and say what it serves. It is found by an idempotency key made of the
 * worker's name, so a restart, a new version and a changed lane list all land on the same message, and a worker
 * that was forgotten shows again.
 */
export async function registerWorker(board: Board, info: WorkerInfo, meters: MeterReading[], now: () => number = Date.now): Promise<WorkerRegistration> {
  const text = (m: MeterReading[]): string => workerText({ ...info, meters: m } satisfies WorkerBlock);
  const root = await board.post(WORKERS_CHANNEL, { text: text(meters), id: `relay-worker:${info.name}`, noSync: true });
  let written = root.text;
  const write = async (status: "online" | "offline", running: number, m: MeterReading[]): Promise<void> => {
    const next = text(m);
    if (next !== written) {
      await board.edit(root.id, next);
      written = next;
    }
    await board.label(root.id, { set: { worker: info.name.slice(0, 256), status, running: String(running), seen: new Date(now()).toISOString() }, unset: ["forgotten"] });
  };
  await write("online", 0, meters);
  return { id: root.id, beat: (state) => write("online", state.running, state.meters), offline: (m) => write("offline", 0, m) };
}

export function workerState(w: { last_seen: string; status: string }, now: number = Date.now()): WorkerState {
  if (w.status === "offline") return "offline";
  const age = now - new Date(w.last_seen).getTime();
  return age < WORKER_ONLINE_MS ? "online" : age < WORKER_OFFLINE_MS ? "idle" : "offline";
}

function toWorker(m: MessageView, now: number): WorkerView | undefined {
  const l = m.labels ?? {};
  const block = blocksOf<WorkerBlock>(m, WORKER_SCHEMA)[0];
  if (!block || m.deleted || l.forgotten) return undefined;
  const last_seen = l.seen ?? m.createdAt;
  const state = workerState({ last_seen, status: l.status ?? "online" }, now);
  return {
    id: m.id,
    by: m.author?.handle ?? m.by.principal,
    name: block.name,
    host: block.host,
    lanes: block.lanes,
    labels: block.labels,
    version: block.version,
    last_seen,
    state,
    retired: state === "offline" && now - new Date(last_seen).getTime() > WORKER_RETIRED_MS,
    running: Number(l.running ?? 0) || 0,
    meters: block.meters,
  };
}

/** Every worker that has a message on the board, by name. */
export async function listWorkers(board: Board, now: number = Date.now()): Promise<WorkerView[]> {
  const out: WorkerView[] = [];
  try {
    for (let page = await board.threads({ channel: WORKERS_CHANNEL, limit: 200 }); ; ) {
      for (const t of page.threads) {
        const w = toWorker(t.message, now);
        if (w) out.push(w);
      }
      if (!page.older) break;
      page = await board.threads({ channel: WORKERS_CHANNEL, before: page.older, limit: 200 });
    }
  } catch (e) {
    throw asTaskError(e);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The lanes a worker that is online or idle serves, sorted: the lanes that would pick a task up now. */
/**
 * Open a task on a lane somebody serves: refused, naming the lanes that have a worker, when nobody does. Every
 * surface that takes a lane from a person or a bot opens tasks through this (the CLI, the site's API, the MCP tool).
 */
export async function openServedTask(board: Board, input: OpenTaskInput): Promise<BoardTask> {
  const problem = laneUnservedProblem(input.lane, servedLanes(await listWorkers(board)));
  if (problem) throw new TaskError(problem, 400);
  return openTask(board, input);
}

export const servedLanes = (workers: WorkerView[]): string[] => [...new Set(workers.filter((w) => w.state !== "offline").flatMap((w) => w.lanes))].sort();

/**
 * Hide a worker from the list (a renamed or decommissioned machine). Its message stays, marked, because the next
 * `relay work` on that machine finds the same message by its key and shows again.
 */
export async function forgetWorker(board: Board, name: string): Promise<WorkerView | undefined> {
  const w = (await listWorkers(board)).find((x) => x.name === name || x.id === name);
  if (!w) return undefined;
  try {
    await board.label(w.id, { set: { forgotten: new Date().toISOString() } });
  } catch (e) {
    throw asTaskError(e);
  }
  return w;
}
