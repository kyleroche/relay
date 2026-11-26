/**
 * The site's handle on the team's Vercel Board, where relay's tasks and workers live (docs/WORKERS.md, "The board").
 * There is one per server instance, like the database handle. In db mode it is the deployment's own: `@vercel/board`
 * finds the credential (OIDC on Vercel, `vercel login` or `BOARD_URL` on a laptop), and the handle carries the
 * watchers the board wakes this deployment for (lib/board-watch.ts, served at /api/board). In mock mode it is an
 * in-memory board seeded with demo tasks and workers (lib/board-demo.ts).
 *
 * The site acts as its deployment whoever asked, so what it does to a task for a person or a bot goes through core's
 * desk (lib/task-ops.ts), which writes their words as a profile named for them. Reads use the session's own handle.
 */
import { board, loadConfig } from "@relay/core";
import { siteWatchers } from "./board-watch.ts";
import { dataMode } from "./mode.ts";

declare global {
  // eslint-disable-next-line no-var
  var __relayBoardHandle: board.Board | undefined;
  // eslint-disable-next-line no-var
  var __relayBoard: Promise<board.BoardSession> | undefined;
  // eslint-disable-next-line no-var
  var __relayWorkers: { at: number; read: Promise<board.WorkerView[]> } | undefined;
}

/**
 * The deployment's handle (db mode). Made once and kept even when a first call fails: its watchers belong to the
 * handle, and a second handle would run them twice.
 */
export function siteHandle(): board.Board {
  globalThis.__relayBoardHandle ??= board.openBoard(loadConfig().board, { watch: siteWatchers(siteBoard) });
  return globalThis.__relayBoardHandle;
}

async function connect(): Promise<board.BoardSession> {
  if (dataMode() !== "db") return (await import("./board-demo.ts")).demoBoard();
  const cfg = loadConfig().board;
  const session = await board.connectBoard(siteHandle(), cfg);
  // once per instance, where an operator reads it: a site that cannot settle other people's tasks
  const queues = await queueAccess(session).catch(() => undefined);
  if (queues && !queues.decides) console.error(`[relay] board: this deployment does not manage the queues. ${queues.access}`);
  return session;
}

/** Whether the deployment may settle tasks other people opened in the queues, with what the board said about it. */
export async function queueAccess(session: board.BoardSession): Promise<{ decides: boolean; access: string }> {
  const a = await board.accessIn(session.board, board.workChannel("any"), session.me);
  return { decides: a.can.includes("manage"), access: `As ${session.me.actor} it may ${a.can.join(", ") || "do nothing"} there (${a.how}).` };
}

/** The board with who the site is on it and whose blocks it believes (its own, then `RELAY_BOARD_FROM`). */
export function siteBoard(): Promise<board.BoardSession> {
  globalThis.__relayBoard ??= connect().catch((e: unknown) => {
    // let the next request ask again instead of keeping a failed sign-on
    globalThis.__relayBoard = undefined;
    throw e;
  });
  return globalThis.__relayBoard;
}

const WORKERS_TTL_MS = 20_000;

/**
 * The fleet, read from the board at most once every 20 seconds per instance: the header's plan meters ask on every
 * page, and a worker's own message changes far less often than that.
 */
export function siteWorkers(now: number = Date.now()): Promise<board.WorkerView[]> {
  const cached = globalThis.__relayWorkers;
  if (cached && now - cached.at < WORKERS_TTL_MS) return cached.read;
  const read = siteBoard()
    .then((s) => board.listWorkers(s.board))
    .catch((e: unknown) => {
      if (globalThis.__relayWorkers?.read === read) globalThis.__relayWorkers = undefined;
      throw e;
    });
  globalThis.__relayWorkers = { at: now, read };
  return read;
}

/** What a page shows in place of the board when it cannot be read: the board's own words and the usual fix. */
export function boardProblem(e: unknown): string {
  return `${board.describeBoardError(e).replace(/[.\s]*$/, ".")} The site reads tasks and workers from the team's Vercel Board: on Vercel the project must be on the team that owns the board; on a laptop, run vercel login (or set BOARD_URL to a local board).`;
}
