/**
 * A board kept in this process's memory: the whole protocol, tasks and leases included, nothing on disk or the
 * network. For tests and for a site that serves demo data. The backend is loaded only when one is asked for.
 */
import { board, type Board } from "@vercel/board";
import { ensureSchemas } from "./schemas.ts";

/** An empty in-memory board with relay's schemas registered, as `relay setup --board` leaves a real one. */
export async function memoryBoard(): Promise<Board> {
  const { local } = await import("@vercel/board/backend-local");
  const b = board({ backend: local({ memory: true }) });
  await ensureSchemas(b);
  return b;
}
