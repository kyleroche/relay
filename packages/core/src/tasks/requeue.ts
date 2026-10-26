/**
 * Requeue: put a task back in the queue, optionally on another lane, from anywhere relay can see it. The case it
 * exists for: a task opened on a cloud lane that nobody has wired (`run.dispatched` makes it look `running` for ever),
 * a run that died without a release, a PR nobody wants to iterate on, or simply the wrong lane. The operator relabels
 * nothing by hand: relay moves the `agent:*` label on the issue, releases the worker's claim if one is live, writes
 * `task.requeued` (which `deriveTaskStatus` folds to `queued`) and rings the doorbell, so the next idle worker that
 * serves the lane claims it and starts over from the base branch.
 *
 * One function behind every surface: the task page's "Requeue" sheet, `relay_task_requeue`,
 * `POST /api/v1/tasks/{id}/requeue` and `relay task requeue`. Allowed from every state except `done`: a merged or
 * closed task is finished, and reopening is GitHub's business.
 *
 * Who may requeue: a person (`human:<login>`) always; a bot (`bot:<token name>`) only when its grant holds
 * `tasks:write`. GitHub is best effort: a label call that fails is recorded in the event payload (`github.error`) and
 * the task is queued anyway, because relay's own `tasks.lane` is what the scheduler matches on.
 */
import type { Db } from "../db/client.ts";
import { writeEvent, type EventRow } from "../db/events.ts";
import { bumpQueueVersion } from "../db/queue.ts";
import { getTask, taskClaims, taskEvents, deriveTaskStatus, taskView, type TaskRow, type TaskStatus, type TaskView } from "../db/tasks.ts";
import { getWorker, liveClaim, releaseClaim } from "../db/workers.ts";
import type { GitHubClient } from "../github/client.ts";
import { isLaneName, isTaskLane, laneLabelSpec, laneNameProblem, laneUnservedProblem } from "./create.ts";

export class TaskRequeueError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TaskRequeueError";
  }
}

export interface RequeueOptions {
  /** The lane the task should run on; omitted keeps the lane it has. */
  lane?: string | null;
  /** Why, for the feed row and the people reading it. */
  reason?: string | null;
  /** The scopes the actor's grant carries; omitted means unrestricted (a local user, a signed-in viewer). */
  scopes?: readonly string[];
}

export interface RequeueResult {
  task: TaskView;
  events: EventRow[];
}

/** What the GitHub side of a requeue did, as recorded in the event payload. */
export type RequeueGitHub = { relabelled: true; removed: string[]; added: string | null } | { relabelled: false; error: string };

export const REQUEUERS_TEXT = "a signed-in person, or a bot whose token holds tasks:write";

/** The label a lane carries on GitHub. */
export const laneLabel = (lane: string): string => `agent:${lane}`;

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Move the issue's `agent:*` label to `lane`: every other `agent:*` label comes off, `agent:<lane>` goes on when it
 * is not already there. Never throws; the outcome is for the payload.
 */
async function relabel(github: GitHubClient | undefined, repo: string, issue: number, lane: string): Promise<RequeueGitHub> {
  if (!github) return { relabelled: false, error: "No GitHub credential: set GITHUB_TOKEN (web) or log in with gh (CLI); move the agent:* label by hand." };
  try {
    const current = await github.getIssue(repo, issue);
    const want = laneLabel(lane);
    const removed: string[] = [];
    for (const l of current.labels) {
      if (l.startsWith("agent:") && l !== want) {
        await github.removeLabel(repo, issue, l);
        removed.push(l);
      }
    }
    let added: string | null = null;
    if (!current.labels.includes(want)) {
      // a registered worker's lane has no label from `relay link`: make it with relay's colour first (best effort)
      if (!isTaskLane(lane)) await github.ensureLabel?.(repo, laneLabelSpec(lane)).catch(() => {});
      await github.addLabels(repo, issue, [want]);
      added = want;
    }
    return { relabelled: true, removed, added };
  } catch (e) {
    return { relabelled: false, error: describe(e) };
  }
}

/**
 * The guard rail: the task exists, is not `done`, the lane (when given) is a lane name that is built-in, cloud or
 * served by a registered worker (the same rule as opening a task; tasks/create.ts), and the actor may do this.
 * Returns the task row and its derived status so the caller folds the events once.
 */
export async function assertRequeueable(db: Db, taskId: string, actor: string, opts: RequeueOptions): Promise<{ task: TaskRow; status: TaskStatus }> {
  const task = await getTask(db, taskId.trim());
  if (!task) throw new TaskRequeueError(`No task ${taskId}.`, 404);
  if (opts.lane != null && opts.lane !== "") {
    if (!isLaneName(opts.lane)) throw new TaskRequeueError(`${laneNameProblem(opts.lane)}.`, 400);
    const unserved = await laneUnservedProblem(db, opts.lane);
    if (unserved) throw new TaskRequeueError(`${unserved}.`, 400);
  }
  if (opts.reason && opts.reason.length > 2000) throw new TaskRequeueError("The reason must be at most 2000 characters.", 400);
  if (!actor.startsWith("human:") && opts.scopes && !opts.scopes.includes("tasks:write")) {
    throw new TaskRequeueError(`${actor} cannot requeue ${task.id}: its token lacks tasks:write. Who can: ${REQUEUERS_TEXT}.`, 403);
  }
  const [events, claims] = await Promise.all([taskEvents(db, task), taskClaims(db, task.id)]);
  const status = deriveTaskStatus(task, events, claims);
  if (status.state === "done") throw new TaskRequeueError(`${task.id} is done (merged or closed); reopen the issue on GitHub to start it again.`, 409);
  return { task, status };
}

/**
 * Requeue the task: update its lane when a different one is given (relay's row first, then the GitHub labels, best
 * effort), release the live claim so a worker can claim again, write `task.requeued` and bump the queue version.
 */
export async function requeueTask(db: Db, github: GitHubClient | undefined, taskId: string, actor: string, opts: RequeueOptions = {}): Promise<RequeueResult> {
  const { task, status } = await assertRequeueable(db, taskId, actor, opts);
  const previousLane = task.lane ?? status.lane;
  const lane: string | null = opts.lane || previousLane;
  const relaned = Boolean(lane && lane !== previousLane);
  if (relaned) await db.query("UPDATE tasks SET lane = $2 WHERE id = $1", [task.id, lane]);
  // the label on GitHub follows relay's row: on a re-lane always; otherwise only when the issue lacks its lane label
  const github_result: RequeueGitHub | null = lane ? await relabel(github, task.repo, task.issue, lane) : null;
  let released: string | null = null;
  const claim = await liveClaim(db, task.id);
  if (claim) {
    const r = await releaseClaim(db, task.id, claim.worker_id, "released");
    if (r) released = (await getWorker(db, claim.worker_id))?.name ?? claim.worker_id;
  }
  const reason = opts.reason?.trim() || null;
  const events: EventRow[] = [];
  const detail = [relaned ? `on the ${lane} lane (was ${previousLane ?? "no lane"})` : lane ? `on the ${lane} lane` : "", `was ${status.state}`].filter(Boolean).join(", ");
  const row = await writeEvent(db, {
    actor,
    project: task.project,
    repo: task.repo,
    issue: task.issue,
    lane,
    pr: status.pr,
    kind: "task.requeued",
    summary: `Requeued #${task.issue} ${detail}${reason ? `: ${reason.split("\n").find((l) => l.trim()) ?? ""}` : ""}`.slice(0, 500),
    url: status.pr_url ?? status.issue_url,
    payload: {
      previous_state: status.state,
      previous_lane: previousLane,
      lane,
      reason,
      github: github_result,
      claim_released: released,
      branch: status.branch,
    },
  });
  if (row) events.push(row);
  await bumpQueueVersion(db); // the task is queued (again): idle workers' doorbells ring
  return { task: await taskView(db, (await getTask(db, task.id)) ?? task), events };
}
