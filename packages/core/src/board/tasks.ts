/**
 * relay's task commands on the board: open, read, list, approve, send back, requeue, close, release. A task is a
 * thread in `work/<project>` whose state the board keeps (`board/mapping.ts` has the vocabulary). Every function
 * takes the caller's own handle, so what it may do is what the board's grants give that caller: there is no relay
 * permission layer in between.
 *
 *   review    the runner opened a pull request and held the task (`awaiting_review`). `approveTask` merges it on
 *             GitHub, then settles the task: unblock, claim, complete with the merge as the result. The merge is the
 *             approval of record, since a board message is not proof of who wrote it.
 *   send back `requestChanges` replies with the note and lifts the hold; the next worker reads the whole thread.
 *   gate      `releaseTask` lifts a hold of the injection gate. Only a task's owner or someone with `manage` can
 *             lift any hold, which is what makes a lifted gate hold a person's decision.
 *
 * A settle can lose the claim to a worker that was waiting for the task (`task_claimed`). That is harmless: a job
 * starts by asking whether the task's pull request is merged, and completes it with no run when it is.
 */
import { BoardError, type Board, type MessageView, type TaskView, type ThreadView } from "@vercel/board";
import type { GitHubClient } from "../github/client.ts";
import { GitHubError } from "../github/client.ts";
import { precheckTask } from "../tasks/gate.ts";
import { isLaneName, isTaskPriority, laneNameProblem, TASK_PRIORITIES, type TaskPriority } from "../tasks/lanes.ts";
import { describeBoardError } from "./client.ts";
import { formatRef, HOLD, LABEL, labelValue, OPEN_STATES, parseRef, projectOfChannel, RELAY_MESSAGE, relayLabels, relayState, splitTaskText, taskText, TEXT_MAX, WORK_SUBTREE, workChannel, type RelayState } from "./mapping.ts";
import { blocksOf, USAGE_SCHEMA, type UsageBlock } from "./schemas.ts";

/** A refusal with the HTTP status a route would answer: 400 bad input, 404 no such task, 409 wrong state, 502/503 GitHub. */
export class TaskError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "TaskError";
  }
}

export interface BoardTask {
  id: string;
  channel: string;
  /** The project whose queue it is in; undefined for a task someone made outside `work/`. */
  project: string | undefined;
  title: string;
  body: string;
  state: RelayState;
  /** The board's own state behind `state`. */
  board_state: TaskView["state"];
  lane: string | null;
  model: string | null;
  repo: string | null;
  base: string | null;
  priority: string | null;
  role: string | null;
  /** On a step's own task: the step it runs and the task whose work it looks at. */
  step: string | null;
  evaluates: string | null;
  /** The GitHub issue it came from, when it did. */
  issue: { repo: string; number: number } | null;
  /** The pull request the runner opened. */
  pr: { repo: string; number: number; url: string } | null;
  branch: string | null;
  /** Why it is held, for review, held and blocked. */
  hold: { kind: string; reason: string } | null;
  /** How it ended: the result of a completed task, the reason of a failed or closed one. */
  result: string | null;
  reason: string | null;
  needs: string[];
  /** Who holds it now and until when. */
  claim: { actor: string; until: string } | null;
  owner: string;
  created_at: string;
  labels: Record<string, string>;
}

export function toTask(m: MessageView): BoardTask {
  if (!m.task) throw new TaskError(`${m.id} is a thread, not a task.`, 404);
  const labels = relayLabels(m);
  const { title, body } = splitTaskText(m.text);
  const pr = parseRef(labels[LABEL.pr]);
  return {
    id: m.id,
    channel: m.channel,
    project: projectOfChannel(m.channel),
    title,
    body,
    state: relayState(m.task),
    board_state: m.task.state,
    lane: labels[LABEL.lane] ?? null,
    model: labels[LABEL.model] ?? null,
    repo: labels[LABEL.repo] ?? null,
    base: labels[LABEL.base] ?? null,
    priority: labels[LABEL.priority] ?? null,
    role: labels[LABEL.role] ?? null,
    step: labels[LABEL.step] ?? null,
    evaluates: labels[LABEL.evaluates] ?? null,
    issue: parseRef(labels[LABEL.issue]) ?? null,
    pr: pr ? { ...pr, url: `https://github.com/${pr.repo}/pull/${pr.number}` } : null,
    branch: labels[LABEL.branch] ?? null,
    hold: m.task.blocked ? { kind: m.task.blocked.kind ?? "", reason: m.task.blocked.reason ?? "" } : null,
    result: m.task.result ?? null,
    reason: m.task.reason ?? null,
    needs: [...(m.task.needs ?? [])],
    claim: m.task.claim ? { actor: m.task.claim.actor, until: m.task.claim.until } : null,
    owner: m.task.owner,
    created_at: m.createdAt,
    labels,
  };
}

export interface OpenTaskInput {
  project: string;
  /** `owner/name` of the repository the work happens in. */
  repo?: string;
  title: string;
  body?: string;
  lane: string;
  model?: string;
  priority?: TaskPriority;
  /** The branch to start from instead of the repository's default one (a handoff of work in progress). */
  base?: string;
  role?: string;
  /** A step this task runs (steps/index.ts), and for an after-pr step the task whose work it looks at and that work's branch. */
  step?: string;
  evaluates?: string;
  branch?: string;
  /** `owner/name#n` of the GitHub issue this task answers. */
  issue?: string;
  /** Tasks that must complete first, by ID. */
  needs?: string[];
  /** The same key again answers the task the first call made. */
  idempotencyKey?: string;
  noSync?: boolean;
}

export function openTaskProblem(i: OpenTaskInput): string | undefined {
  if (!i.title?.trim()) return "title is required";
  if (i.title.trim().length > 200) return "title is at most 200 characters";
  if (!isLaneName(i.lane)) return laneNameProblem(i.lane);
  if (i.priority !== undefined && !isTaskPriority(i.priority)) return `priority must be one of ${TASK_PRIORITIES.join(", ")}`;
  if (i.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(i.repo)) return `repo must be owner/name, not '${i.repo}'`;
  if (i.issue !== undefined && !parseRef(i.issue)) return `issue must be owner/name#n, not '${i.issue}'`;
  if (i.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(i.model)) return `model '${i.model}' is not a model id`;
  return undefined;
}

/**
 * Open a task in the project's queue. Text the injection gate's pre-check flags is held as it is made (claimed in
 * the same write, then held), so no worker ever sees it ready. A body past the board's message limit goes in an
 * attachment, `task.md`, which the runner reads in its place.
 */
export async function openTask(board: Board, input: OpenTaskInput): Promise<BoardTask> {
  const problem = openTaskProblem(input);
  if (problem) throw new TaskError(problem, 400);
  const title = input.title.trim();
  const body = (input.body ?? "").trim();
  const labels: Record<string, string> = { [LABEL.lane]: input.lane };
  if (input.model) labels[LABEL.model] = input.model;
  if (input.repo) labels[LABEL.repo] = input.repo;
  if (input.base) labels[LABEL.base] = labelValue(input.base);
  if (input.priority) labels[LABEL.priority] = input.priority;
  if (input.role) labels[LABEL.role] = labelValue(input.role);
  if (input.issue) labels[LABEL.issue] = input.issue;
  if (input.step) labels[LABEL.step] = input.step;
  if (input.evaluates) labels[LABEL.evaluates] = input.evaluates;
  if (input.branch) labels[LABEL.branch] = labelValue(input.branch);
  let text = taskText(title, body);
  const attachments = [];
  if (text.length > TEXT_MAX) {
    attachments.push(await board.upload({ data: new TextEncoder().encode(body), name: "task.md", type: "text/markdown" }));
    text = taskText(title, `The full text of this task is in the attached task.md (${body.length.toLocaleString("en-US")} characters).`);
  }
  const hits = precheckTask(`${title}\n\n${body}`);
  try {
    const made = await board.tasks.create(workChannel(input.project), {
      text,
      labels,
      ...(attachments.length ? { attachments } : {}),
      ...(input.needs?.length ? { needs: input.needs } : {}),
      ...(input.idempotencyKey ? { id: input.idempotencyKey } : {}),
      ...(input.noSync ? { noSync: true } : {}),
      ...(hits.length ? { claim: true } : {}),
    });
    if (hits.length && made.claim) return toTask(await made.claim.block(`pre-check: ${hits.join(", ")}`.slice(0, 900), { kind: HOLD.gate }));
    return toTask(made.task);
  } catch (e) {
    throw asTaskError(e);
  }
}

/** A board failure as the refusal a command prints, with the status the board gave. */
export function asTaskError(e: unknown): Error {
  if (e instanceof TaskError) return e;
  if (e instanceof BoardError) return new TaskError(describeBoardError(e), e.status ?? 502);
  return e instanceof Error ? e : new Error(String(e));
}

export interface TaskDetail {
  task: BoardTask;
  thread: ThreadView;
  /** Every usage row posted in the thread, oldest first. */
  usage: UsageBlock[];
  /** What people (and agents that are not relay's runner) wrote in the thread, oldest first: review notes, answers, questions. */
  notes: Array<{ id: string; by: string; text: string; at: string }>;
}

async function readThread(board: Board, id: string): Promise<ThreadView> {
  try {
    return await board.thread(id.trim());
  } catch (e) {
    if (e instanceof BoardError && (e.code === "message_not_found" || e.status === 404)) throw new TaskError(`No task ${id}.`, 404);
    throw asTaskError(e);
  }
}

/** The words in a thread that are input to the work: every reply relay did not write itself, plus the notes it wrote for a reviewer. */
export function threadNotes(thread: ThreadView): TaskDetail["notes"] {
  return thread.replies
    .filter((m) => !m.deleted && m.text.trim() && (m.labels?.[LABEL.relay] === undefined || m.labels[LABEL.relay] === RELAY_MESSAGE.note))
    .map((m) => ({ id: m.id, by: m.author?.handle ?? m.by.actor, text: m.text, at: m.createdAt }));
}

export async function getTask(board: Board, id: string): Promise<TaskDetail> {
  const thread = await readThread(board, id);
  return { task: toTask(thread.message), thread, usage: thread.replies.flatMap((m) => blocksOf<UsageBlock>(m, USAGE_SCHEMA)), notes: threadNotes(thread) };
}

export interface ListTasksOptions {
  project?: string;
  /** One of relay's states, `open` (everything not done or closed; the default) or `all`. */
  state?: RelayState | "open" | "all";
  lane?: string;
  limit?: number;
}

const BOARD_STATE: Record<RelayState, TaskView["state"]> = { waiting: "waiting", queued: "ready", running: "claimed", review: "blocked", held: "blocked", blocked: "blocked", done: "completed", failed: "failed", closed: "canceled" };

/** Tasks oldest first, the order a queue works them in. */
export async function listTasks(board: Board, opts: ListTasksOptions = {}): Promise<BoardTask[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
  const want = opts.state ?? "open";
  const state = want === "open" || want === "all" ? want : BOARD_STATE[want];
  if (!state) throw new TaskError(`state must be one of ${[...OPEN_STATES, "done", "closed", "open", "all"].join(", ")}`, 400);
  const out: BoardTask[] = [];
  let after: string | undefined;
  try {
    for (;;) {
      const page = await board.tasks.list({ channel: opts.project ? workChannel(opts.project) : WORK_SUBTREE, state, ...(opts.lane ? { label: { [LABEL.lane]: opts.lane } } : {}), ...(after ? { after } : {}), limit: 50 });
      for (const t of page.tasks) {
        const task = toTask(t.message);
        if (want !== "open" && want !== "all" && task.state !== want) continue; // review, held and blocked share one board state
        out.push(task);
        if (out.length >= limit) return out;
      }
      if (page.tasks.length < 50 || page.cursor === after) return out;
      after = page.cursor;
    }
  } catch (e) {
    throw asTaskError(e);
  }
}

const describeGitHub = (e: unknown): string => (e instanceof GitHubError ? e.message : e instanceof Error ? e.message : String(e));

/**
 * Finish a held task as its pull request (or asset) was accepted: lift the hold, take it, complete it. `settled` is
 * false when a waiting worker took it first; that worker completes it when it sees the merge.
 */
export async function settleTask(board: Board, id: string, result: string): Promise<{ settled: boolean; task: BoardTask }> {
  try {
    await board.tasks.unblock(id);
    const claim = await board.tasks.claim(id);
    return { settled: true, task: toTask(await claim.complete(result.slice(0, 900))) };
  } catch (e) {
    if (e instanceof BoardError && (e.code === "task_claimed" || e.code === "task_finished")) return { settled: false, task: toTask((await readThread(board, id)).message) };
    throw asTaskError(e);
  }
}

export interface ApproveOptions {
  method?: "squash" | "merge" | "rebase";
  keepBranch?: boolean;
  /** Who approved, for the merge commit's body (the caller's handle). */
  by?: string;
}

export interface ApproveResult {
  task: BoardTask;
  merged: boolean;
  merge_sha: string | null;
  pr_url: string;
  branch_deleted: boolean;
  /** False when a waiting worker took the task before this call could complete it; it completes on that worker's next look. */
  settled: boolean;
}

function assertReview(task: BoardTask, verb: string): asserts task is BoardTask & { pr: NonNullable<BoardTask["pr"]> } {
  if (task.state !== "review") throw new TaskError(`${task.id} is ${task.state}, not in review; only a task in review can be ${verb}.`, 409);
  if (!task.pr) throw new TaskError(`${task.id} is in review but has no pull request on it (its deliverable is an asset: review it with the asset commands).`, 409);
}

/** Approve: squash-merge the task's pull request, delete its branch, say so in the thread, and complete the task. */
export async function approveTask(board: Board, github: GitHubClient | undefined, id: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const { task } = await getTask(board, id);
  assertReview(task, "approved");
  if (!github) throw new TaskError("No GitHub credential: log in with gh (CLI) or connect GitHub (site).", 503);
  const { repo, number, url } = task.pr;
  let pull;
  try {
    pull = await github.getPullRequest(repo, number);
  } catch (e) {
    throw new TaskError(`GitHub could not read PR #${number} of ${repo}: ${describeGitHub(e)}`, 502);
  }
  let sha: string | null = null;
  let branchDeleted = false;
  if (!pull.merged) {
    if (pull.state !== "open") throw new TaskError(`PR #${number} is ${pull.state}, not open.`, 409);
    const closes = task.issue && task.issue.repo === repo ? `\n\nCloses #${task.issue.number}` : "";
    try {
      const merge = await github.mergePullRequest(repo, number, { method: opts.method ?? "squash", title: `${pull.title} (#${number})`, message: `relay: approved${opts.by ? ` by ${opts.by}` : ""} (task ${task.id})${closes}`, sha: pull.head_sha });
      sha = merge.sha || null;
    } catch (e) {
      const reason = describeGitHub(e);
      await board.reply(id, { text: `Merge of #${number} refused: ${reason}`.slice(0, 900), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true }).catch(() => undefined);
      throw new TaskError(`GitHub refused to merge #${number}: ${reason}`, 502);
    }
    if (!opts.keepBranch && pull.head_ref) {
      branchDeleted = await github.deleteBranch(repo, pull.head_ref).then(
        () => true,
        () => false, // the merge stands; the branch can go by hand
      );
    }
  }
  const result = `merged ${formatRef(repo, number)}${sha ? ` in ${sha.slice(0, 7)}` : ""}`;
  const done = await settleTask(board, id, result);
  return { task: done.task, merged: true, merge_sha: sha, pr_url: url, branch_deleted: branchDeleted, settled: done.settled };
}

/** Send a task in review back: the note goes in the thread (and on the pull request when GitHub is at hand), and the hold is lifted. */
export async function requestChanges(board: Board, github: GitHubClient | undefined, id: string, note: string): Promise<BoardTask> {
  const text = note.trim();
  if (!text) throw new TaskError("a note is required: say what to change.", 400);
  if (text.length > 6000) throw new TaskError("the note is at most 6,000 characters.", 400);
  const { task } = await getTask(board, id);
  if (task.state !== "review") throw new TaskError(`${task.id} is ${task.state}, not in review; only a task in review can be sent back.`, 409);
  try {
    await board.reply(id, { text, labels: { [LABEL.relay]: RELAY_MESSAGE.note } });
    if (github && task.pr) await github.createComment(task.pr.repo, task.pr.number, `**Changes requested** (relay task ${task.id})\n\n${text}`).catch(() => undefined);
    return toTask(await board.tasks.unblock(id));
  } catch (e) {
    throw asTaskError(e);
  }
}

/** Lift the injection gate's hold. The board lets only the task's owner, or someone who manages its channel, do it. */
export async function releaseTask(board: Board, id: string): Promise<BoardTask> {
  const { task } = await getTask(board, id);
  if (task.state !== "held") throw new TaskError(`${task.id} is ${task.state}, not held; only a task the gate holds can be released.`, 409);
  try {
    return toTask(await board.tasks.unblock(id));
  } catch (e) {
    throw asTaskError(e);
  }
}

export interface RequeueOptions {
  /** Move it to another lane on the way. */
  lane?: string;
  /** Ask for another model, or `null` to go back to the lane's default. */
  model?: string | null;
}

/**
 * Back to the queue from anything but done, closed or running: a failed task is reopened, a held one unblocked, a
 * queued one only relabelled. A running task belongs to the worker that holds it until its lease ends, so it is refused
 * with who and until when.
 */
export async function requeueTask(board: Board, id: string, opts: RequeueOptions = {}): Promise<BoardTask> {
  if (opts.lane !== undefined && !isLaneName(opts.lane)) throw new TaskError(laneNameProblem(opts.lane), 400);
  const { task } = await getTask(board, id);
  if (task.state === "done" || task.state === "closed") throw new TaskError(`${task.id} is ${task.state}; a finished task is not requeued. Open a new one.`, 409);
  if (task.state === "running") throw new TaskError(`${task.id} is running on ${task.claim?.actor ?? "a worker"}${task.claim ? ` until ${task.claim.until}` : ""}; it returns to the queue by itself if that worker stops renewing. Close it to stop the run.`, 409);
  try {
    const set: Record<string, string> = {};
    const unset: string[] = [];
    if (opts.lane && opts.lane !== task.lane) set[LABEL.lane] = opts.lane;
    if (opts.model === null && task.model) unset.push(LABEL.model);
    else if (opts.model && opts.model !== task.model) set[LABEL.model] = opts.model;
    if (Object.keys(set).length || unset.length) await board.label(id, { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
    if (task.state === "failed") return toTask(await board.tasks.reopen(id));
    if (task.state === "review" || task.state === "held" || task.state === "blocked") return toTask(await board.tasks.unblock(id));
    return toTask((await readThread(board, id)).message);
  } catch (e) {
    throw asTaskError(e);
  }
}

export interface CloseResult {
  task: BoardTask;
  /** What happened on GitHub, best effort: the pull request and the issue this task answered. */
  github: { pr_closed: boolean; issue_closed: boolean; error?: string };
}

/** Finish a task without a merge: canceled on the board with the reason, its open pull request and its issue closed on GitHub. */
export async function closeTask(board: Board, github: GitHubClient | undefined, id: string, opts: { reason?: string } = {}): Promise<CloseResult> {
  const reason = (opts.reason ?? "").trim();
  if (reason.length > 900) throw new TaskError("the reason is at most 900 characters.", 400);
  const { task } = await getTask(board, id);
  if (task.state === "done" || task.state === "closed") throw new TaskError(`${task.id} is already ${task.state}.`, 409);
  let canceled;
  try {
    canceled = toTask(await board.tasks.cancel(id, reason || "closed without a merge"));
  } catch (e) {
    throw asTaskError(e);
  }
  const gh: CloseResult["github"] = { pr_closed: false, issue_closed: false };
  if (github) {
    const comment = `Closed by relay without a merge (task ${task.id})${reason ? `: ${reason}` : "."}`;
    try {
      if (task.pr) {
        const pull = await github.getPullRequest(task.pr.repo, task.pr.number);
        if (pull.state === "open" && !pull.merged) {
          await github.createComment(task.pr.repo, task.pr.number, comment);
          await github.request("PATCH", `/repos/${task.pr.repo}/pulls/${task.pr.number}`, { state: "closed" });
          gh.pr_closed = true;
        }
      }
      if (task.issue) {
        await github.createComment(task.issue.repo, task.issue.number, comment);
        await github.request("PATCH", `/repos/${task.issue.repo}/issues/${task.issue.number}`, { state: "closed", state_reason: "not_planned" });
        gh.issue_closed = true;
      }
    } catch (e) {
      gh.error = describeGitHub(e).slice(0, 300);
    }
  }
  return { task: canceled, github: gh };
}
