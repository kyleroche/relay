/**
 * What the board wakes this deployment for (served at /api/board, docs/ARCHITECTURE.md "The site and the board").
 * Two watchers, both on every project's queue (`work/`):
 *
 *   ledger   any event brings relay's feed up to the board (`syncLedger`). The feed is the durable copy the feed and
 *            usage pages read; the board is where it happened.
 *   brief    a new task gets relay's memory for it posted in its thread as `brief.md`, so a worker needs nothing
 *            from the site but the board.
 *
 * Where no watcher runs (local dev, a board at `BOARD_URL`), page loads call the same sync through `syncFeedAfter`.
 * The sync reads from a cursor kept in the database and writes each row once, so any number of callers may overlap.
 */
import { board, compileBrief, type Db } from "@relay/core";
import type { BoardEventView, Watcher } from "@vercel/board";
import { after } from "next/server";
import { getDb } from "./db.ts";
import { dataMode } from "./mode.ts";

/**
 * The brief for a task that was just made: relay's memory for its project, lane and text, posted once in its thread
 * as whoever `as` is. Nothing for any other event, a thread outside a project's queue, or a step's own task (an eval
 * reads the work it looks at, not the project's memory). True when a brief was posted.
 */
export async function briefNewTask(db: Db, as: board.Board, event: BoardEventView): Promise<boolean> {
  const m = event.message;
  if (event.type !== "task.created" || !m || m.re !== null || !m.task) return false;
  const task = board.toTask(m);
  if (!task.project || task.step) return false;
  const brief = await compileBrief(db, { project: task.project, intent: "implement the task", maxTokens: 2500, ...(task.lane ? { lane: task.lane } : {}), issue: { title: task.title, body: task.body } });
  if (!brief.text.trim()) return false;
  return board.postBrief(as, task.id, brief.text);
}

export function siteWatchers(session: () => Promise<board.BoardSession>): Record<string, Watcher> {
  return {
    ledger: { tail: board.WORK_SUBTREE, run: async () => void (await board.syncLedger(await getDb(), await session())) },
    brief: { tail: board.WORK_SUBTREE, run: async ({ event, board: as }) => void (await briefNewTask(await getDb(), as, event)) },
  };
}

const SYNC_EVERY_MS = 15_000;

declare global {
  // eslint-disable-next-line no-var
  var __relayLedgerSyncAt: number | undefined;
}

/** True at most once per 15 seconds per instance: whether a page load should sync the feed. */
export function syncDue(now: number = Date.now()): boolean {
  if (globalThis.__relayLedgerSyncAt !== undefined && now - globalThis.__relayLedgerSyncAt < SYNC_EVERY_MS) return false;
  globalThis.__relayLedgerSyncAt = now;
  return true;
}

/**
 * Sync the feed after this response, when one is due. Called from the pages that show the feed or what is derived
 * from it, so it is current even where the board wakes nothing. A failure is logged and the next load tries again.
 */
export function syncFeedAfter(session: () => Promise<board.BoardSession>): void {
  if (dataMode() !== "db" || !syncDue()) return;
  after(async () => {
    try {
      await board.syncLedger(await getDb(), await session());
    } catch (e) {
      console.error(`[relay] ledger sync: ${board.describeBoardError(e)}`);
    }
  });
}
