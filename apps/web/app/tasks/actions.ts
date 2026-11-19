"use server";

import { board } from "@relay/core";
import { revalidatePath } from "next/cache";
import { siteBoard } from "@/lib/board";
import { dataMode } from "@/lib/data";
import { CROSS_SITE_MESSAGE } from "@/lib/fetch-site";
import { siteGitHub } from "@/lib/integrations";
import { requestIsCrossSite, viewerActor } from "@/lib/session";
import { approveFor, closeFor, releaseFor, requestChangesFor, requeueFor, type Asker } from "@/lib/task-ops";
import { taskPagePath } from "@/lib/tasks";

/** Every action on a task answers with this. */
export interface TaskActionResult {
  ok: boolean;
  message?: string;
  /** The task's state after the action. */
  state?: string;
}

const DEMO: TaskActionResult = { ok: false, message: "This is the demo board; decisions need a deployment on a real one." };
const SIGNED_OUT: TaskActionResult = { ok: false, message: "Your session has ended. Sign in again." };
const CROSS_SITE: TaskActionResult = { ok: false, message: CROSS_SITE_MESSAGE };

async function viewer(): Promise<string | undefined> {
  try {
    return await viewerActor();
  } catch {
    return undefined;
  }
}

/**
 * One decision by the signed-in person: the refusals every action starts with (the demo board, a cross-site request
 * (lib/fetch-site.ts), no session), then the board write as that person, then both pages that show the task.
 */
async function decide(taskId: string, run: (session: board.BoardSession, asker: Asker) => Promise<TaskActionResult>): Promise<TaskActionResult> {
  if (dataMode() !== "db") return DEMO;
  if (await requestIsCrossSite()) return CROSS_SITE;
  const actor = await viewer();
  if (!actor) return SIGNED_OUT;
  try {
    return await run(await siteBoard(), { actor });
  } catch (e) {
    return { ok: false, message: board.describeBoardError(e) };
  } finally {
    revalidatePath(taskPagePath(taskId));
    revalidatePath("/");
  }
}

/** Approve: squash-merge the pull request the task's hold names (or accept its outputs) and complete the task. */
export async function approveTaskAction(taskId: string): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => {
    const r = await approveFor(session, await siteGitHub(), asker, taskId);
    return { ok: true, state: r.task.state, message: r.pr_url ? `Merged${r.merge_sha ? ` in ${r.merge_sha.slice(0, 7)}` : ""}${r.branch_deleted ? "; the branch is deleted" : ""}.` : "Outputs approved." };
  });
}

/** Request changes: the note goes in the thread and on the pull request, and the task is queued for the next run. */
export async function requestChangesAction(taskId: string, note: string): Promise<TaskActionResult> {
  if (!note.trim()) return { ok: false, message: "Say what should change; the note goes in the thread and to the next run." };
  return decide(taskId, async (session, asker) => ({ ok: true, state: (await requestChangesFor(session, await siteGitHub(), asker, taskId, note)).state }));
}

/** Release a task the injection gate held, for its text as it stands. */
export async function releaseTaskAction(taskId: string): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => ({ ok: true, state: (await releaseFor(session, asker, taskId)).state }));
}

/** Requeue, optionally on another lane or model; `model: null` goes back to the lane's default. */
export async function requeueTaskAction(taskId: string, input: { lane?: string; model?: string | null }): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => {
    const t = await requeueFor(session, asker, taskId, { ...(input.lane ? { lane: input.lane } : {}), ...(input.model !== undefined ? { model: input.model } : {}) });
    return { ok: true, state: t.state };
  });
}

/** Close without a merge: canceled on the board, its open pull request and its issue closed on GitHub (best effort). */
export async function closeTaskAction(taskId: string, reason?: string): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => {
    const r = await closeFor(session, await siteGitHub(), asker, taskId, reason?.trim() || undefined);
    const also = [r.github.pr_closed ? "its pull request is closed" : "", r.github.issue_closed ? "its issue is closed" : "", r.to_review ? `${r.to_review} goes to review without it` : "", r.github.error ? `GitHub: ${r.github.error}` : ""].filter(Boolean);
    return { ok: true, state: r.task.state, ...(also.length ? { message: `${also.join("; ")}.` } : {}) };
  });
}
