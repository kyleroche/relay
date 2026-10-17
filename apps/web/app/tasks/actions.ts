"use server";

import { approveTask, requestChanges, requeueTask, TaskRequeueError, TaskReviewError } from "@relay/core";
import { revalidatePath } from "next/cache";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { CROSS_SITE_MESSAGE } from "@/lib/fetch-site";
import { siteGitHub } from "@/lib/integrations";
import { requestIsCrossSite, viewerActor } from "@/lib/session";

/** Every action on a task page answers with this. */
export interface TaskActionResult {
  ok: boolean;
  message?: string;
  /** The task's state after the action. */
  state?: string;
}

const NO_DB: TaskActionResult = { ok: false, message: "This needs a database; the deployment runs on demo data." };
const SIGNED_OUT: TaskActionResult = { ok: false, message: "Your session has ended. Sign in again." };
const CROSS_SITE: TaskActionResult = { ok: false, message: CROSS_SITE_MESSAGE };

async function actor(): Promise<string | undefined> {
  try {
    return await viewerActor();
  } catch {
    return undefined;
  }
}

/** The refusal every action starts with, or who is acting: no database, a cross-site request (lib/fetch-site.ts), no session. */
async function gate(): Promise<{ refused: TaskActionResult; by?: never } | { refused?: never; by: string }> {
  if (dataMode() !== "db") return { refused: NO_DB };
  if (await requestIsCrossSite()) return { refused: CROSS_SITE };
  const by = await actor();
  return by ? { by } : { refused: SIGNED_OUT };
}

const describe = (e: unknown): string => (e instanceof TaskReviewError || e instanceof TaskRequeueError || e instanceof Error ? e.message : String(e));

function pagePath(taskId: string): string {
  const [repo, n] = taskId.split("#");
  return `/tasks/${repo}/${n}`;
}

/** Approve and merge: the same core call the API and the MCP tool make, attributed to the signed-in person. */
export async function approveTaskAction(taskId: string): Promise<TaskActionResult> {
  const g = await gate();
  if (g.refused) return g.refused;
  try {
    const r = await approveTask(await getDb(), await siteGitHub(), taskId, g.by);
    dispatchAfter(r.events);
    revalidatePath(pagePath(taskId));
    revalidatePath("/tasks");
    return { ok: true, state: r.task.state };
  } catch (e) {
    revalidatePath(pagePath(taskId)); // a merge refusal wrote task.merge_failed; show it
    return { ok: false, message: describe(e) };
  }
}

/** Request changes with a note: a PR comment plus task.changes_requested; the task is queued again. */
export async function requestChangesAction(taskId: string, note: string): Promise<TaskActionResult> {
  const g = await gate();
  if (g.refused) return g.refused;
  if (!note.trim()) return { ok: false, message: "Say what should change; the note goes to the PR and to the next run." };
  try {
    const r = await requestChanges(await getDb(), await siteGitHub(), taskId, g.by, note);
    dispatchAfter(r.events);
    revalidatePath(pagePath(taskId));
    revalidatePath("/tasks");
    return { ok: true, state: r.task.state };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}

/** Requeue, optionally on another lane: the agent:* label moves, a live claim is released, task.requeued is written. */
export async function requeueTaskAction(taskId: string, input: { lane?: string | null; reason?: string | null }): Promise<TaskActionResult> {
  const g = await gate();
  if (g.refused) return g.refused;
  try {
    const r = await requeueTask(await getDb(), await siteGitHub(), taskId, g.by, { lane: input.lane ?? null, reason: input.reason ?? null });
    dispatchAfter(r.events);
    revalidatePath(pagePath(taskId));
    revalidatePath("/tasks");
    const github = r.events[0]?.payload.github as { relabelled: boolean; error?: string } | null | undefined;
    return { ok: true, state: r.task.state, ...(github && !github.relabelled ? { message: `Queued, but the GitHub label did not move: ${github.error ?? "unknown error"}.` } : {}) };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}
