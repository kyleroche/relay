/**
 * Close: finish a task without a merge, from anywhere relay can see it. The case it exists for: a task opened by
 * mistake or against a spec the repo does not match, a run that would only waste a subscription window, a duplicate.
 * relay closes the issue on GitHub as "not planned" with the reason as a comment (best effort, recorded in the
 * payload), closes an open PR the same way, releases the worker's claim if one is live, writes `task.closed` (which
 * `deriveTaskStatus` folds to `done`) and bumps the queue version so the doorbells stop counting it.
 *
 * One function behind every surface: the board card's and the task page's "Close", `relay_task_close`,
 * `POST /api/v1/tasks/{id}/close` and `relay task close`. Allowed from every state except `done`: a merged or
 * closed task is finished already, and reopening is GitHub's business.
 *
 * Who may close: a person (`human:<login>`) always; a bot (`bot:<token name>`) only when its grant holds
 * `tasks:write`. GitHub is best effort: a call that fails is recorded in the event payload (`github.error`) and the
 * task is done anyway, because relay's own feed is what the board and the scheduler read.
 */
import type { Db } from "../db/client.ts";
import { writeEvent, type EventRow } from "../db/events.ts";
import { bumpQueueVersion } from "../db/queue.ts";
import { getTask, taskClaims, taskEvents, deriveTaskStatus, taskView, type TaskRow, type TaskStatus, type TaskView } from "../db/tasks.ts";
import { getWorker, liveClaim, releaseClaim } from "../db/workers.ts";
import type { GitHubClient } from "../github/client.ts";
import { REQUEUERS_TEXT } from "./requeue.ts";

export class TaskCloseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TaskCloseError";
  }
}

export interface CloseOptions {
  /** Why, for the feed row and the issue comment. */
  reason?: string | null;
  /** The scopes the actor's grant carries; omitted means unrestricted (a local user, a signed-in viewer). */
  scopes?: readonly string[];
}

export interface CloseResult {
  task: TaskView;
  events: EventRow[];
}

/** What the GitHub side of a close did, as recorded in the event payload. */
export type CloseGitHub = { closed: true; comment_url: string | null; pr_closed: number | null } | { closed: false; error: string };

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** The comment relay leaves on the issue (and the PR) when it closes a task. */
export const closeComment = (actor: string, reason: string | null): string => `relay: closed by ${actor}${reason ? `: ${reason}` : " without a merge"}`;

/**
 * Close the issue as not planned, with the comment first so the thread says why; close an open PR the same way.
 * Never throws; the outcome is for the payload.
 */
async function closeOnGitHub(github: GitHubClient | undefined, repo: string, issue: number, pr: number | null, actor: string, reason: string | null): Promise<CloseGitHub> {
  if (!github) return { closed: false, error: "No GitHub credential: set GITHUB_TOKEN (web) or log in with gh (CLI); close the issue by hand." };
  try {
    const body = closeComment(actor, reason);
    const comment = await github.createComment(repo, issue, body);
    await github.request("PATCH", `/repos/${repo}/issues/${issue}`, { state: "closed", state_reason: "not_planned" });
    let pr_closed: number | null = null;
    if (pr) {
      try {
        const p = await github.getPullRequest(repo, pr);
        if (p.state === "open") {
          await github.createComment(repo, pr, body);
          await github.request("PATCH", `/repos/${repo}/pulls/${pr}`, { state: "closed" });
          pr_closed = pr;
        }
      } catch {
        /* the issue is closed; a PR that would not close stays for the person to look at */
      }
    }
    return { closed: true, comment_url: comment.html_url || null, pr_closed };
  } catch (e) {
    return { closed: false, error: describe(e) };
  }
}

/** The guard rail: the task exists, is not `done`, the reason fits, and the actor may do this. */
export async function assertClosable(db: Db, taskId: string, actor: string, opts: CloseOptions): Promise<{ task: TaskRow; status: TaskStatus }> {
  const task = await getTask(db, taskId.trim());
  if (!task) throw new TaskCloseError(`No task ${taskId}.`, 404);
  if (opts.reason && opts.reason.length > 2000) throw new TaskCloseError("The reason must be at most 2000 characters.", 400);
  if (!actor.startsWith("human:") && opts.scopes && !opts.scopes.includes("tasks:write")) {
    throw new TaskCloseError(`${actor} cannot close ${task.id}: its token lacks tasks:write. Who can: ${REQUEUERS_TEXT}.`, 403);
  }
  const [events, claims] = await Promise.all([taskEvents(db, task), taskClaims(db, task.id)]);
  const status = deriveTaskStatus(task, events, claims);
  if (status.state === "done") throw new TaskCloseError(`${task.id} is already done (merged or closed).`, 409);
  return { task, status };
}

/**
 * Close the task: the issue (and an open PR) on GitHub, best effort; a live claim released so the worker stops;
 * `task.closed` written; the queue version bumped so the doorbells drop it.
 */
export async function closeTask(db: Db, github: GitHubClient | undefined, taskId: string, actor: string, opts: CloseOptions = {}): Promise<CloseResult> {
  const { task, status } = await assertClosable(db, taskId, actor, opts);
  const reason = opts.reason?.trim() || null;
  const github_result = await closeOnGitHub(github, task.repo, task.issue, status.pr, actor, reason);
  let released: string | null = null;
  const claim = await liveClaim(db, task.id);
  if (claim) {
    const r = await releaseClaim(db, task.id, claim.worker_id, "released");
    if (r) released = (await getWorker(db, claim.worker_id))?.name ?? claim.worker_id;
  }
  const events: EventRow[] = [];
  const row = await writeEvent(db, {
    actor,
    project: task.project,
    repo: task.repo,
    issue: task.issue,
    lane: task.lane ?? status.lane,
    pr: status.pr,
    kind: "task.closed",
    summary: `Closed #${task.issue} without a merge (was ${status.state})${reason ? `: ${reason.split("\n").find((l) => l.trim()) ?? ""}` : ""}`.slice(0, 500),
    url: status.issue_url ?? status.pr_url,
    payload: {
      previous_state: status.state,
      reason,
      github: github_result,
      claim_released: released,
      pr: status.pr,
      branch: status.branch,
    },
  });
  if (row) events.push(row);
  await bumpQueueVersion(db); // one task fewer looks queued or running: the doorbells see the version move
  return { task: await taskView(db, (await getTask(db, task.id)) ?? task), events };
}
