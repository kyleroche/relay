import { board } from "@relay/core";
import type { NextResponse } from "next/server";
import { problem } from "@/lib/api";
import { TaskRefusal } from "@/lib/task-ops";

const TITLE: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable" };

/**
 * A task refusal as a problem document: the status core's `TaskError` carries (400 bad input, 403 not this caller's
 * to decide, 404 no such task, 409 wrong state, 502/503 GitHub or the board). Anything else is rethrown for `api()`.
 */
export function taskProblem(e: unknown, instance: string): NextResponse {
  if (e instanceof board.BoardError) e = board.asTaskError(e);
  if (!(e instanceof board.TaskError)) throw e;
  // the board's own 401/403 is about the site's credential, not the caller's: answer as an upstream failure
  const status = e instanceof TaskRefusal || ![401, 403].includes(e.status) ? e.status : 502;
  return problem(status, TITLE[status] ?? "Error", e.message, instance, e instanceof TaskRefusal && e.parameter ? { parameter: e.parameter } : {});
}
