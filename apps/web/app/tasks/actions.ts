"use server";

import { ANY_LANE, board, capProblem, CLOUD_LANE } from "@relay/core";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { siteBoard } from "@/lib/board";
import { cloudConfig, cloudProblem } from "@/lib/cloud/config";
import { runApprovedQuietly } from "@/lib/cloud/pool";
import { dataMode } from "@/lib/data";
import { CROSS_SITE_MESSAGE } from "@/lib/fetch-site";
import { siteGitHub } from "@/lib/integrations";
import { projectProfile } from "@/lib/profile";
import { requestIsCrossSite, viewerActor } from "@/lib/session";
import { approveFor, closeFor, releaseFor, requestChangesFor, requeueFor, type Asker } from "@/lib/task-ops";
import { taskPagePath } from "@/lib/tasks";

/** Every action on a task answers with this. */
export interface TaskActionResult {
  ok: boolean;
  message?: string;
  /** The task's state after the action. */
  state?: string;
  /** The tasks an approved plan opened, in the order they were opened. */
  opened?: string[];
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

/**
 * Approve: squash-merge the pull request the task's hold names, accept its outputs, mark its report as read, or open
 * the tasks of the plan it proposed; then complete the task.
 */
export async function approveTaskAction(taskId: string): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => {
    const r = await approveFor(session, await siteGitHub(), asker, taskId);
    if (r.opened) return { ok: true, state: r.task.state, opened: r.opened, message: `Plan approved: opened ${r.opened.length} task${r.opened.length === 1 ? "" : "s"}, each waiting for what it needs.` };
    if (r.pr_url) return { ok: true, state: r.task.state, message: `Merged${r.merge_sha ? ` in ${r.merge_sha.slice(0, 7)}` : ""}${r.branch_deleted ? "; the branch is deleted" : ""}.` };
    return { ok: true, state: r.task.state, message: r.task.result?.startsWith("report read") ? "Marked as read." : "Outputs approved." };
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

/**
 * Grant a task one capability set of its project's profile, for its text as it stands. Core lets only a signed-in
 * person grant (board/desk.ts); its refusal is the message.
 */
export async function grantSetAction(taskId: string, set: string): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => {
    const { task } = await board.getTask(session.board, taskId);
    // a set the profile does not define adds nothing to a job; say so instead of writing a grant that reads as one
    const { profile, why } = await projectProfile(task.repo);
    if (!profile?.sets[set]) return { ok: false, message: profile ? `The project's profile defines no set '${set}'.` : (why ?? "The project's profile could not be read.") };
    const t = await board.grantFor(board.deskFor(session, asker), taskId, { set });
    return { ok: true, state: t.state, message: `Granted ${set} for the task's text as it stands.` };
  });
}

/**
 * Approve one paid sandbox run of a queued task, up to a cap: the owner's yes, without which nothing spends. The
 * grant is tied to the task's text, so an edit of the task voids it. The pool then starts the run (lib/cloud/pool.ts),
 * unless one of the owner's own workers takes the task first.
 */
export async function approveCloudRunAction(taskId: string, capUsd: number): Promise<TaskActionResult> {
  return decide(taskId, async (session, asker) => {
    const problem = cloudProblem() ?? capProblem(capUsd, cloudConfig().limits.maxCapUsd);
    if (problem) return { ok: false, message: problem };
    const { task } = await board.getTask(session.board, taskId);
    if (task.state !== "queued") return { ok: false, message: `The task is ${task.state} now; a paid run is for a task that waits in the queue.` };
    if (task.lane !== CLOUD_LANE && task.lane !== ANY_LANE) return { ok: false, message: `A paid run uses the ${CLOUD_LANE} lane; this task is on ${task.lane ?? "no lane"}. Requeue it on ${CLOUD_LANE} first.` };
    const { profile, why } = await projectProfile(task.repo);
    if (!profile) return { ok: false, message: why ?? "The project's profile could not be read, so it is not known to allow a paid run." };
    if (profile.cloud === "never") return { ok: false, message: "This project's profile says cloud: never; its tasks wait for one of your own machines." };
    const cap = Math.round(capUsd * 100) / 100;
    await board.grantFor(board.deskFor(session, asker), taskId, { cloudCapUsd: cap });
    after(runApprovedQuietly);
    return { ok: true, state: task.state, message: `Approved up to $${cap.toFixed(2)}. A sandbox starts shortly, unless one of your workers takes the task first.` };
  });
}
