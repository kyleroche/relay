/**
 * Shared bits for the worker routes (/api/v1/workers, /api/v1/work/*): WorkError to problem+json, the task id from
 * the `{owner}/{repo}%23{issue}` path pair, and small body readers. The protocol itself is @relay/core's work/server.ts.
 */
import { parseTaskId, WorkError } from "@relay/core";
import type { NextResponse } from "next/server";
import { problem } from "@/lib/api";

export function workProblem(e: unknown, instance: string): NextResponse | undefined {
  if (!(e instanceof WorkError)) return undefined;
  const title = e.status === 404 ? "Not Found" : e.status === 409 ? "Conflict" : "Bad Request";
  return problem(e.status, title, e.message, instance);
}

/** `owner` and `repo#n` (the `#` arrives as `%23`, already decoded by Next) back into `owner/repo#n`. */
export function taskIdFrom(owner: string, task: string): string | undefined {
  const id = `${decodeURIComponent(owner)}/${decodeURIComponent(task)}`;
  return parseTaskId(id) ? id : undefined;
}

export const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
