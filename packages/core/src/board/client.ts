/**
 * The handle on the board relay's tasks live on. There is no relay credential behind it: `@vercel/board` finds the
 * caller's own (a deployment's OIDC token, `BOARD_TOKEN`, the machine's `vercel login`), so a worker, the CLI and
 * the site each act as who they are, and `BOARD_URL` points all of them at a local board (`vb serve`) instead.
 */
import { board, BoardError, type Board, type BoardOptions, type Me } from "@vercel/board";
import type { BoardConfig } from "../config.ts";

export type { Board, Me } from "@vercel/board";
export { BoardError } from "@vercel/board";

/**
 * The team's board: the default one, or the named one. A name the team does not have is an error, never a new
 * board, unless `create` says to make it (`relay setup --board --create`). `watch` is for a deployment: the tails
 * the board wakes it for (the site's `app/api/board` route serves the handle's `fetch`).
 */
export function openBoard(cfg: Partial<BoardConfig> = {}, opts: { create?: boolean; watch?: BoardOptions["watch"] } = {}): Board {
  return board({ ...(cfg.team ? { team: cfg.team } : {}), ...(cfg.name ? { name: cfg.name, ensure: opts.create === true } : {}), ...(opts.watch ? { watch: opts.watch } : {}) });
}

/** A board with who the caller is on it and whose tasks it takes. */
export interface BoardSession {
  board: Board;
  me: Me;
  /** The owners a claim names: the caller's own principal first (a profile owns nothing its principal made), then the configured ones. */
  from: string[];
}

export async function connectBoard(b: Board, cfg: Partial<BoardConfig> = {}): Promise<BoardSession> {
  const me = await b.me();
  return { board: b, me, from: [...new Set([me.principal, ...(cfg.from ?? [])].filter(Boolean))] };
}

/** What a failed board call says, in one line a person can act on: the board's own message, and its hint when it has one. */
export function describeBoardError(e: unknown): string {
  if (e instanceof BoardError) return `${e.message}${e.hint ? ` ${e.hint}` : ""}`.replace(/\s+/g, " ").trim();
  return e instanceof Error ? e.message : String(e);
}
export const boardCode = (e: unknown): string | undefined => (e instanceof BoardError ? e.code : undefined);
