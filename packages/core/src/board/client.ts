/**
 * The handle on the board relay's tasks live on. There is no relay credential behind it: `@vercel/board` finds the
 * caller's own (a deployment's OIDC token, `BOARD_TOKEN`, the machine's `vercel login`), so a worker, the CLI and
 * the site each act as who they are, and `BOARD_URL` points all of them at a local board (`vb serve`) instead.
 */
import { board, BoardError, type Board, type BoardEventView, type Me } from "@vercel/board";
import type { BoardConfig } from "../config.ts";

export type { Board, Me } from "@vercel/board";
export { BoardError } from "@vercel/board";

/** The team's board: the default one, or the named one. A name the team does not have is an error, never a new board. */
export function openBoard(cfg: Partial<BoardConfig> = {}): Board {
  return board({ ...(cfg.team ? { team: cfg.team } : {}), ...(cfg.name ? { name: cfg.name, ensure: false } : {}) });
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

/** Everything that happened in a thread after its root was written, oldest first: task changes, label changes, replies. */
export async function threadEvents(b: Board, id: string, limit = 500): Promise<BoardEventView[]> {
  const out: BoardEventView[] = [];
  let after = id;
  while (out.length < limit) {
    const page = await b.poll({ re: id, after, wait: 0 });
    if (!page.events.length) break;
    out.push(...page.events);
    if (page.cursor === after) break;
    after = page.cursor;
  }
  return out;
}
