/**
 * The review step: what happens to a task after its PR is open (docs/ARCHITECTURE.md, "A task's life", step 6).
 *
 *   approveTask      squash-merge the PR through GitHub, delete the head branch, write `task.approved`; the task is
 *                    `done`. A merge GitHub refuses writes `task.merge_failed` with GitHub's message and throws.
 *   requestChanges   comment on the PR (`relay: changes requested by <actor>:` + the note), write
 *                    `task.changes_requested`; the task is `queued` again and the next run finds the note in its
 *                    brief ("Review feedback", brief/index.ts) and pushes to the same branch and PR.
 *
 * One function behind every surface: the task page's buttons, `relay_task_approve` / `relay_task_request_changes`,
 * `POST /api/v1/tasks/{id}/approve` and `/request-changes`, `relay task approve` / `relay task changes`.
 *
 * Who may decide: a person (`human:<login>`) always. A bot (`bot:<token name>`) only when its grant holds
 * `tasks:write`, and never on a PR its own lane produced (the `run.started` / `pr.opened` actor carries the same
 * name): a bot does not approve its own work. The refusal says who can.
 */
import type { Db } from "../db/client.ts";
import { writeEvent, type EventRow } from "../db/events.ts";
import { bumpQueueVersion } from "../db/queue.ts";
import { getTask, taskClaims, taskEvents, deriveTaskStatus, taskView, type TaskRow, type TaskStatus, type TaskView } from "../db/tasks.ts";
import { GitHubError, type GitHubClient } from "../github/client.ts";

export class TaskReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "TaskReviewError";
  }
}

export interface ReviewOptions {
  /** The scopes the actor's grant carries; omitted means unrestricted (a local user, a signed-in viewer). */
  scopes?: readonly string[];
  /** Merge method (squash by default). */
  method?: "squash" | "merge" | "rebase";
  /** Keep the head branch after the merge (default: delete it). */
  keepBranch?: boolean;
}

export interface ReviewResult {
  task: TaskView;
  events: EventRow[];
}

/** The name behind an actor, so `bot:oauth:codex-bot`, `runner:codex-bot` and `agent:codex-bot` compare equal. */
const nameOf = (actor: string): string =>
  actor
    .slice(actor.indexOf(":") + 1)
    .replace(/^oauth:/, "")
    .toLowerCase();

/** Who can approve or send back, in the words a refusal uses. */
export const REVIEWERS_TEXT = "a signed-in person, or a bot whose token holds tasks:write and that did not produce the PR itself";

/**
 * The guard rail every decision passes: the task is in review with an open PR, and the actor may decide on it.
 * Returns the derived status (already loaded, so the caller does not fold the events twice).
 */
export async function assertReviewable(db: Db, task: TaskRow, actor: string, opts: ReviewOptions, verb: "approve" | "request changes on"): Promise<{ status: TaskStatus; events: EventRow[] }> {
  const [events, claims] = await Promise.all([taskEvents(db, task), taskClaims(db, task.id)]);
  const status = deriveTaskStatus(task, events, claims);
  if (!actor.startsWith("human:")) {
    if (opts.scopes && !opts.scopes.includes("tasks:write")) throw new TaskReviewError(`${actor} cannot ${verb} ${task.id}: its token lacks tasks:write. Who can: ${REVIEWERS_TEXT}.`, 403);
    const me = nameOf(actor);
    const produced = events.some((e) => (e.kind === "run.started" || e.kind === "pr.opened" || e.kind === "run.finished") && nameOf(e.actor) === me);
    if (produced) throw new TaskReviewError(`${actor} cannot ${verb} ${task.id}: it produced this PR. A bot never approves its own work; who can: ${REVIEWERS_TEXT}.`, 403);
  }
  if (status.state !== "review") throw new TaskReviewError(`${task.id} is ${status.state}, not in review; only a task in review with an open PR can be ${verb === "approve" ? "approved" : "sent back"}.`, 409);
  if (status.pr == null) throw new TaskReviewError(`${task.id} is in review but relay has no pull request for it yet (pr.opened has not arrived).`, 409);
  return { status, events };
}

async function loadTask(db: Db, taskId: string): Promise<TaskRow> {
  const task = await getTask(db, taskId.trim());
  if (!task) throw new TaskReviewError(`No task ${taskId}.`, 404);
  return task;
}

/**
 * Approve: merge the PR (squash), delete its branch, record it. The merge commit's title is the PR title with its
 * number; the body names who approved and closes the issue. The task is `done` once `task.approved` is written;
 * GitHub's own `pr.merged` arrives later and agrees.
 */
export async function approveTask(db: Db, github: GitHubClient | undefined, taskId: string, actor: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const task = await loadTask(db, taskId);
  const { status } = await assertReviewable(db, task, actor, opts, "approve");
  if (!github) throw new TaskReviewError("No GitHub credential: set GITHUB_TOKEN (web) or log in with gh (CLI).", 503);
  const number = status.pr as number;
  const events: EventRow[] = [];
  const base = { actor, project: task.project, repo: task.repo, issue: task.issue, lane: status.lane, pr: number };
  let pull;
  try {
    pull = await github.getPullRequest(task.repo, number);
  } catch (e) {
    throw new TaskReviewError(`GitHub could not read PR #${number} of ${task.repo}: ${describe(e)}`, 502);
  }
  if (pull.merged) throw new TaskReviewError(`PR #${number} is already merged; relay is waiting for GitHub's pr.merged.`, 409);
  if (pull.state !== "open") throw new TaskReviewError(`PR #${number} is ${pull.state}, not open.`, 409);
  const method = opts.method ?? "squash";
  let merge;
  try {
    merge = await github.mergePullRequest(task.repo, number, {
      method,
      title: `${pull.title} (#${number})`,
      message: `relay: approved by ${actor}\n\nCloses #${task.issue}`,
      sha: pull.head_sha,
    });
  } catch (e) {
    const reason = describe(e);
    const failed = await writeEvent(db, {
      ...base,
      kind: "task.merge_failed",
      summary: `Merge of #${number} refused: ${reason}`.slice(0, 500),
      url: pull.html_url,
      payload: { error: reason, method, head_sha: pull.head_sha, status: e instanceof GitHubError ? e.status ?? null : null },
    });
    if (failed) events.push(failed);
    throw new TaskReviewError(`GitHub refused to merge #${number}: ${reason}`, 502);
  }
  let branchDeleted = false;
  if (!opts.keepBranch && pull.head_ref) {
    try {
      await github.deleteBranch(task.repo, pull.head_ref);
      branchDeleted = true;
    } catch {
      branchDeleted = false; // the merge stands; the branch can go by hand
    }
  }
  const approved = await writeEvent(db, {
    ...base,
    kind: "task.approved",
    summary: `Approved and merged #${number}${merge.sha ? ` (${merge.sha.slice(0, 7)})` : ""}`,
    url: pull.html_url,
    payload: { merged: true, merge_sha: merge.sha, method, branch: pull.head_ref, branch_deleted: branchDeleted, pr_title: pull.title },
    dedupe_key: `task:${task.id}:approved:${merge.sha || number}`,
  });
  if (approved) events.push(approved);
  return { task: await taskView(db, task), events };
}

/**
 * Send the PR back with a note. The note becomes a PR comment (so it is on GitHub, where the work is) and a
 * `task.changes_requested` row (so the task is queued and the next run's brief carries it).
 */
export async function requestChanges(db: Db, github: GitHubClient | undefined, taskId: string, actor: string, note: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const text = note.trim();
  if (!text) throw new TaskReviewError("A note is required: say what should change.", 400);
  if (text.length > 10_000) throw new TaskReviewError("The note must be at most 10000 characters.", 400);
  const task = await loadTask(db, taskId);
  const { status } = await assertReviewable(db, task, actor, opts, "request changes on");
  if (!github) throw new TaskReviewError("No GitHub credential: set GITHUB_TOKEN (web) or log in with gh (CLI).", 503);
  const number = status.pr as number;
  let comment;
  try {
    comment = await github.createComment(task.repo, number, `relay: changes requested by ${actor}:\n\n${text}\n`);
  } catch (e) {
    throw new TaskReviewError(`GitHub refused the comment on #${number}: ${describe(e)}`, 502);
  }
  const events: EventRow[] = [];
  const row = await writeEvent(db, {
    actor,
    project: task.project,
    repo: task.repo,
    issue: task.issue,
    lane: status.lane,
    pr: number,
    kind: "task.changes_requested",
    summary: `Changes requested on #${number}: ${text.split("\n").find((l) => l.trim()) ?? ""}`.slice(0, 500),
    url: comment.html_url || status.pr_url,
    payload: { note: text, comment_id: comment.id, comment_url: comment.html_url, branch: status.branch },
  });
  if (row) events.push(row);
  await bumpQueueVersion(db); // the task is queued again: idle workers' doorbells ring
  return { task: await taskView(db, task), events };
}

/** The notes reviewers left on a task's PRs, oldest first, for the brief and the task page. */
export async function reviewNotes(db: Db, task: Pick<TaskRow, "repo" | "project" | "issue">, limit = 5): Promise<Array<{ by: string; at: string; note: string; pr: number | null }>> {
  const r = await db.query(
    `SELECT actor, ts, pr, payload FROM events WHERE kind = 'task.changes_requested' AND issue = $3 AND (repo = $1 OR (repo IS NULL AND project = $2)) ORDER BY ts DESC, id DESC LIMIT $4`,
    [task.repo, task.project, task.issue, limit],
  );
  return r
    .map((x) => {
      const payload = (typeof x.payload === "string" ? JSON.parse(x.payload) : x.payload ?? {}) as Record<string, unknown>;
      return { by: x.actor as string, at: x.ts instanceof Date ? x.ts.toISOString() : String(x.ts), pr: x.pr == null ? null : Number(x.pr), note: typeof payload.note === "string" ? payload.note : "" };
    })
    .filter((n) => n.note)
    .reverse();
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
