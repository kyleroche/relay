/**
 * The workers of a board, kept on the board itself: one thread per machine in `relay/workers`, whose root labels say
 * what the machine serves and when it was last seen, and whose newest `relay-worker@1` block carries the plan meters
 * its logins report. A worker writes its own thread; anyone who reads the channel sees the fleet, so `relay work
 * status`, the lane registry and the site's workers page need no table.
 *
 * Posted with `noSync`, so it never reaches Slack or GitHub.
 */
import { BoardError, type Board, type MessageView } from "@vercel/board";
import type { MeterReading } from "../meters.ts";
import { asTaskError } from "./tasks.ts";
import { labelValue, WORKERS_CHANNEL } from "./mapping.ts";
import { blocksOf, WORKER_SCHEMA, workerText, type WorkerBlock } from "./schemas.ts";

/** Seen within this window, a worker is online: its idle wait on the board is shorter than this. */
export const WORKER_ONLINE_MS = 12 * 60_000;
/** Silent for longer than this (or after a clean stop), it is offline. */
export const WORKER_OFFLINE_MS = 60 * 60_000;
/** Offline for longer than this, it is retired: folded away until `forgetWorker` removes its thread. */
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
  /** The worker's thread on the board. */
  id: string;
  /** Who runs it: the login behind its thread. */
  by: string;
  last_seen: string;
  state: WorkerState;
  retired: boolean;
  /** How many jobs it said it was running at its last sign of life. */
  running: number;
  meters: MeterReading[];
}

const csv = (xs: string[]): string => labelValue(xs.join(","));
const uncsv = (s: string | undefined): string[] => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const sameMeters = (a: MeterReading[], b: MeterReading[]): boolean => JSON.stringify(a) === JSON.stringify(b);

function labelsFor(info: WorkerInfo, status: "online" | "offline", running: number, now: number): Record<string, string> {
  return { worker: labelValue(info.name), host: labelValue(info.host), lanes: csv(info.lanes), caps: csv(info.labels) || "-", version: labelValue(info.version), status, running: String(running), seen: new Date(now).toISOString() };
}

export interface WorkerRegistration {
  /** The worker's thread. */
  id: string;
  /** A sign of life: the labels are rewritten, and a new block is posted when the meters changed. */
  beat(state: { running: number; meters: MeterReading[] }): Promise<void>;
  /** A clean stop. */
  offline(meters: MeterReading[]): Promise<void>;
}

/**
 * Take (or make) this machine's thread and say what it serves. The thread is found by an idempotency key made of the
 * worker's name, so a restart, a new version and a changed lane list all land on the same thread.
 */
export async function registerWorker(board: Board, info: WorkerInfo, meters: MeterReading[], now: () => number = Date.now): Promise<WorkerRegistration> {
  const root = await board.post(WORKERS_CHANNEL, { text: `${info.name} on ${info.host}`, id: `relay-worker:${info.name}`, noSync: true });
  let posted: MeterReading[] | undefined;
  const say = async (m: MeterReading[]): Promise<void> => {
    if (posted && sameMeters(posted, m)) return;
    const block: WorkerBlock = { ...info, meters: m };
    // a board whose schemas nobody registered yet still gets the labels; the block waits for `relay setup --board`
    await board.reply(root.id, { text: workerText(block), noSync: true }).catch((e: unknown) => {
      if (!(e instanceof BoardError && e.code === "schema_not_found")) throw e;
    });
    posted = m;
  };
  await board.label(root.id, { set: labelsFor(info, "online", 0, now()) });
  await say(meters);
  return {
    id: root.id,
    async beat(state) {
      await board.label(root.id, { set: labelsFor(info, "online", state.running, now()) });
      await say(state.meters);
    },
    async offline(m) {
      await board.label(root.id, { set: labelsFor(info, "offline", 0, now()) });
      await say(m);
    },
  };
}

export function workerState(w: { last_seen: string; status: string }, now: number = Date.now()): WorkerState {
  if (w.status === "offline") return "offline";
  const age = now - new Date(w.last_seen).getTime();
  return age < WORKER_ONLINE_MS ? "online" : age < WORKER_OFFLINE_MS ? "idle" : "offline";
}

function toWorker(root: MessageView, latest: MessageView | null | undefined, now: number): WorkerView | undefined {
  const l = root.labels ?? {};
  if (!l.worker || root.deleted) return undefined;
  const last_seen = l.seen ?? root.createdAt;
  const state = workerState({ last_seen, status: l.status ?? "online" }, now);
  const block = latest ? blocksOf<WorkerBlock>(latest, WORKER_SCHEMA)[0] : undefined;
  return {
    id: root.id,
    by: root.author?.handle ?? root.by.principal,
    name: l.worker,
    host: l.host ?? "",
    lanes: uncsv(l.lanes),
    labels: l.caps === "-" ? [] : uncsv(l.caps),
    version: l.version ?? "",
    last_seen,
    state,
    retired: state === "offline" && now - new Date(last_seen).getTime() > WORKER_RETIRED_MS,
    running: Number(l.running ?? 0) || 0,
    meters: block?.meters ?? [],
  };
}

/** Every worker that has a thread on the board, by name. The meters are those of each thread's newest message. */
export async function listWorkers(board: Board, now: number = Date.now()): Promise<WorkerView[]> {
  const out: WorkerView[] = [];
  try {
    for (let page = await board.threads({ channel: WORKERS_CHANNEL, limit: 200 }); ; ) {
      for (const t of page.threads) {
        const w = toWorker(t.message, t.last, now);
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

/** The lanes some worker that is not retired has registered, sorted. */
export const servedLanes = (workers: WorkerView[]): string[] => [...new Set(workers.filter((w) => !w.retired).flatMap((w) => w.lanes))].sort();

/** Remove a worker's thread (a renamed or decommissioned machine). The board lets only its author do it; it registers again if it ever runs `relay work`. */
export async function forgetWorker(board: Board, name: string): Promise<WorkerView | undefined> {
  const w = (await listWorkers(board)).find((x) => x.name === name || x.id === name);
  if (!w) return undefined;
  try {
    await board.delete(w.id);
  } catch (e) {
    throw asTaskError(e);
  }
  return w;
}
