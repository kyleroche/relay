/**
 * relay's task commands on the board: open, read, list, approve, send back, requeue, close, release. A task is a
 * thread in `work/<project>` whose state the board keeps (`board/mapping.ts` has the vocabulary). Every function
 * takes the caller's own handle, so what it may do is what the board's grants give that caller: there is no relay
 * permission layer in between.
 *
 * What these act on comes from places the board guards, never from labels (board/schemas.ts):
 *   the repository, base and issue   the `relay-task` block in the task's own text, which is its owner's
 *   the pull request in review       the hold's reason, which only the claim that held the task could write, and
 *                                    then only if its head branch is one a lane pushed for this task
 *
 *   review    the runner opened a pull request and held the task (`awaiting_review`). `approveTask` merges it on
 *             GitHub, then settles the task. The merge is the approval of record, since a board message is not
 *             proof of who wrote it.
 *   send back `requestChanges` replies with the note and lifts the hold; the next worker reads the whole thread.
 *   gate      `releaseTask` lifts a hold of the injection gate for the text as it stands (a `relay-release` block
 *             with its digest), so text added afterwards is graded again.
 *
 * A held task is finished or re-held without a worker getting in between by taking its `lane` label off first: a
 * worker claims by lane, so a task with none is out of every worker's reach while the hold is lifted (`takeHeld`).
 */
import { BoardError, type Board, type ClaimedTask, type MessageView, type TaskView, type ThreadView } from "@vercel/board";
import type { GitHubClient } from "../github/client.ts";
import { GitHubError } from "../github/client.ts";
import { gateText, precheckTask } from "../tasks/gate.ts";
import { isLaneName, laneNameProblem } from "../tasks/lanes.ts";
import { sha256 } from "../util.ts";
import { describeBoardError } from "./client.ts";
import { HOLD, isBranchOf, LABEL, OPEN_STATES, parseEvalHold, parsePullUrl, parseRef, projectOfChannel, RELAY_MESSAGE, relayLabels, relayState, splitTaskText, taskText, TEXT_MAX, WORK_SUBTREE, workChannel, type RelayState } from "./mapping.ts";
import { ASSET_SCHEMA, blocksOf, evalText, prose, releaseText, RUN_SCHEMA, TASK_SCHEMA, taskBlockText, USAGE_SCHEMA, withoutBlocks, type AssetBlock, type RunBlock, type TaskBlock, type UsageBlock } from "./schemas.ts";

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
  /** From the task's own text (`relay-task`): where the work happens, where it starts, the issue it answers. */
  repo: string | null;
  base: string | null;
  issue: { repo: string; number: number } | null;
  /** On a step's own task: the step it runs, the task whose work it looks at, and that work's branch. */
  step: string | null;
  evaluates: string | null;
  branch: string | null;
  /** The pull request a task in review waits on: the reason of its hold. */
  pr: { repo: string; number: number; url: string } | null;
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
  const { title, body } = splitTaskText(withoutBlocks(m.text));
  const routing = blocksOf<TaskBlock>(m, TASK_SCHEMA)[0] ?? {};
  const hold = m.task.blocked ? { kind: m.task.blocked.kind ?? "", reason: m.task.blocked.reason ?? "" } : null;
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
    repo: routing.repo ?? null,
    base: routing.base ?? null,
    issue: parseRef(routing.issue) ?? null,
    step: routing.step ?? null,
    evaluates: routing.evaluates ?? null,
    branch: routing.branch ?? null,
    pr: (hold?.kind === HOLD.review ? parsePullUrl(hold.reason) : hold?.kind === HOLD.eval ? parsePullUrl(parseEvalHold(hold.reason)?.pr) : undefined) ?? null,
    hold,
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
  /** The branch to start from instead of the repository's default one (a handoff of work in progress). */
  base?: string;
  /** `owner/name#n` of the GitHub issue this task answers. */
  issue?: string;
  /** A step this task runs (steps/index.ts), and for an after-pr step the task whose work it looks at and that work's branch. */
  step?: string;
  evaluates?: string;
  branch?: string;
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
  if (i.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(i.repo)) return `repo must be owner/name, not '${i.repo}'`;
  if (i.issue !== undefined && !parseRef(i.issue)) return `issue must be owner/name#n, not '${i.issue}'`;
  if (i.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(i.model)) return `model '${i.model}' is not a model id`;
  return undefined;
}

/** A board failure as the refusal a command prints, with the status the board gave. */
export function asTaskError(e: unknown): Error {
  if (e instanceof TaskError) return e;
  if (e instanceof BoardError && e.code === "schema_not_found") return new TaskError(`${describeBoardError(e)}. relay's schemas are registered once per team: relay setup --board`, 409);
  if (e instanceof BoardError) return new TaskError(describeBoardError(e), e.status ?? 502);
  return e instanceof Error ? e : new Error(String(e));
}

/** A task as it was just made: not yet in any worker's reach, until `release` puts it there or `hold` keeps it out. */
interface Made {
  task: MessageView;
  flagged: string[];
  hold(reason: string, kind: string): Promise<MessageView>;
  release(): Promise<MessageView>;
}

/**
 * Make the task without letting a worker see it ready first. A task with nothing to wait for is claimed in the same
 * write, so the caller decides whether it is released or held. A task that waits for others cannot be claimed (the
 * board refuses), and needs no claim: it is not ready, and its owner may hold it as it is.
 */
async function make(board: Board, input: OpenTaskInput): Promise<Made> {
  const problem = openTaskProblem(input);
  if (problem) throw new TaskError(problem, 400);
  const title = input.title.trim();
  const body = (input.body ?? "").trim();
  const labels: Record<string, string> = { [LABEL.lane]: input.lane, ...(input.model ? { [LABEL.model]: input.model } : {}) };
  const routing: TaskBlock = {};
  for (const key of ["repo", "base", "issue", "step", "evaluates", "branch"] as const) if (input[key]) routing[key] = input[key];
  const block = Object.keys(routing).length ? `\n\n${taskBlockText(routing)}` : "";
  let text = `${taskText(title, prose(body))}${block}`;
  const attachments = [];
  if (text.length > TEXT_MAX) {
    attachments.push(await board.upload({ data: new TextEncoder().encode(body), name: "task.md", type: "text/markdown" }));
    text = `${taskText(title, `The full text of this task is in the attached task.md (${body.length.toLocaleString("en-US")} characters).`)}${block}`;
  }
  const waits = !!input.needs?.length;
  const made = await board.tasks.create(workChannel(input.project), {
    text,
    labels,
    ...(attachments.length ? { attachments } : {}),
    ...(waits ? { needs: input.needs! } : { claim: true }),
    ...(input.idempotencyKey ? { id: input.idempotencyKey } : {}),
    ...(input.noSync ? { noSync: true } : {}),
  });
  const { task, claim } = made;
  const flagged = precheckTask(`${title}\n\n${body}`);
  if (claim) return { task, flagged, hold: (reason, kind) => claim.block(reason, { kind }), release: () => claim.release() };
  // no claim: it waits for other tasks, or the same idempotency key was used before and the task is as it was left
  return { task, flagged: waits ? flagged : [], hold: (reason, kind) => board.tasks.block(task.id, reason, { kind }), release: async () => task };
}

/**
 * Open a task in the project's queue. Text the injection gate's pre-check flags is held as it is made, so no worker
 * ever sees it ready. A body past the board's message limit goes in an attachment, `task.md`, which the runner reads
 * in its place.
 */
export async function openTask(board: Board, input: OpenTaskInput): Promise<BoardTask> {
  try {
    const made = await make(board, input);
    return toTask(made.flagged.length ? await made.hold(`pre-check: ${made.flagged.join(", ")}`.slice(0, 900), HOLD.gate) : await made.release());
  } catch (e) {
    throw asTaskError(e);
  }
}

/**
 * Open a task and keep it out of every worker's reach until `release` is called: for a task that only makes sense
 * once something else is in place. `cancel` calls it off instead.
 */
export async function openTaskHeldBack(board: Board, input: Omit<OpenTaskInput, "needs" | "idempotencyKey">): Promise<{ task: BoardTask; release: () => Promise<void>; cancel: (reason: string) => Promise<void> }> {
  try {
    const made = await make(board, input);
    if (made.flagged.length) {
      await made.hold(`pre-check: ${made.flagged.join(", ")}`.slice(0, 900), HOLD.gate);
      throw new TaskError(`${made.task.id} was held by the gate's pre-check as it was made (${made.flagged.join(", ")})`, 409);
    }
    return {
      task: toTask(made.task),
      release: async () => void (await made.release()),
      cancel: async (reason) => {
        await made.release().catch(() => undefined);
        await board.tasks.cancel(made.task.id, reason.slice(0, 900));
      },
    };
  } catch (e) {
    throw asTaskError(e);
  }
}

export interface TaskDetail {
  task: BoardTask;
  thread: ThreadView;
  /** Every usage row posted in the thread, oldest first. */
  usage: UsageBlock[];
  /** What people (and agents that are not relay's runner) wrote in the thread, oldest first: review notes, answers, questions, an eval's findings. */
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

/**
 * The words in a thread that are input to the work: every reply that is not relay's own machinery (its log, result,
 * usage, brief and asset messages), without the data blocks. A reply that is only a block has no words and is not a note.
 */
export function threadNotes(thread: ThreadView): TaskDetail["notes"] {
  return thread.replies
    .filter((m) => !m.deleted && (m.labels?.[LABEL.relay] === undefined || m.labels[LABEL.relay] === RELAY_MESSAGE.note))
    .map((m) => ({ id: m.id, by: m.author?.handle ?? m.by.actor, text: withoutBlocks(m.text), at: m.createdAt }))
    .filter((n) => n.text);
}

/** A task's body, read from `task.md` when its text was too long for a message (`openTask`). */
export async function fullBody(board: Board, thread: ThreadView, body: string): Promise<string> {
  const file = thread.message.attachments.find((a) => a.name === "task.md");
  if (!file) return body;
  const res = await board.download(file.id).catch(() => undefined);
  return res?.ok ? await res.text() : body;
}

/**
 * What the injection gate grades for a task, and its digest: the title, the body, and the notes people added. A
 * release names the digest it was given for, so it covers that text and no text added later.
 */
export async function gateInput(board: Board, thread: ThreadView): Promise<{ text: string; digest: string; title: string; body: string; notes: TaskDetail["notes"] }> {
  const task = toTask(thread.message);
  const body = await fullBody(board, thread, task.body);
  const notes = threadNotes(thread);
  const text = gateText({ title: task.title, body, note: notes.length ? notes.map((n) => n.text).join("\n\n") : null });
  return { text, digest: sha256(text), title: task.title, body, notes };
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

/**
 * Tasks oldest first, the order a queue works them in. relay's `open` is everything not done or closed, so a failed
 * task counts (a requeue retries it); the board's own `open` leaves failed ones out, and they are read beside it.
 */
export async function listTasks(board: Board, opts: ListTasksOptions = {}): Promise<BoardTask[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
  const want = opts.state ?? "open";
  if (want !== "open" && want !== "all" && !BOARD_STATE[want]) throw new TaskError(`state must be one of ${[...OPEN_STATES, "done", "closed", "open", "all"].join(", ")}`, 400);
  const read = async (state: TaskView["state"] | "open" | "all"): Promise<BoardTask[]> => {
    const out: BoardTask[] = [];
    let after: string | undefined;
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
  };
  try {
    if (want !== "open") return await read(want === "all" ? "all" : BOARD_STATE[want]);
    const [open, failed] = await Promise.all([read("open"), read("failed")]);
    if (!failed.length) return open;
    const seen = new Set(open.map((t) => t.id));
    return [...open, ...failed.filter((t) => !seen.has(t.id))].sort((a, z) => a.created_at.localeCompare(z.created_at)).slice(0, limit);
  } catch (e) {
    throw asTaskError(e);
  }
}

export interface RecentTasksOptions {
  /** One project's queue; without it, every project's. */
  project?: string;
  /** Only these states; without it, every task. */
  states?: readonly RelayState[];
  limit?: number;
  /** The `older` of the page before, to read one project's queue further back. */
  before?: string;
}

/**
 * Tasks by latest activity, newest first: what a person reads, where `listTasks` is the order a queue is worked in.
 * The board reads threads by activity one channel at a time, so one project pages back through everything with
 * `older`, and without a project this is the newest `limit` across all of them and `older` is null.
 */
export async function recentTasks(board: Board, opts: RecentTasksOptions = {}): Promise<{ tasks: BoardTask[]; older: string | null }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const states = opts.states?.length ? new Set(opts.states) : undefined;
  // review, held and blocked share one board state, so the board narrows and relay's own state decides
  const label = [states ? `board.task=${[...new Set([...states].map((s) => BOARD_STATE[s]))].join("|")}` : "board.task"];
  const read = async (channel: string, before?: string) => {
    const page = await board.threads({ channel, label, limit, ...(before ? { before } : {}) });
    const rows = page.threads
      .filter((t) => t.message.task)
      .map((t) => ({ task: toTask(t.message), at: t.last?.createdAt ?? t.message.createdAt }))
      .filter((r) => !states || states.has(r.task.state))
      .reverse();
    return { rows, older: page.older ?? null };
  };
  try {
    if (opts.project) {
      const page = await read(workChannel(opts.project), opts.before);
      return { tasks: page.rows.map((r) => r.task), older: page.older };
    }
    const queues = (await board.channels({ prefix: WORK_SUBTREE, limit: 500 })).channels.map((c) => c.path).filter((path) => projectOfChannel(path));
    const rows = (await Promise.all(queues.map((channel) => read(channel)))).flatMap((p) => p.rows);
    return { tasks: rows.sort((a, z) => z.at.localeCompare(a.at)).slice(0, limit).map((r) => r.task), older: null };
  } catch (e) {
    throw asTaskError(e);
  }
}

const describeGitHub = (e: unknown): string => (e instanceof GitHubError ? e.message : e instanceof Error ? e.message : String(e));

/**
 * Take a held task for the caller: its `lane` label comes off first, so no worker can claim it once the hold lifts,
 * then the hold is lifted and the task claimed. What the caller does with the claim (complete it, hold it again for
 * another reason) decides the rest; a caller that hands the task back to workers puts the lane on again.
 */
export async function takeHeld(board: Board, id: string): Promise<ClaimedTask> {
  await board.label(id, { unset: [LABEL.lane] });
  await board.tasks.unblock(id);
  return board.tasks.claim(id);
}

/** Finish a held task as its pull request (or its outputs) was accepted. */
export async function settleTask(board: Board, id: string, result: string): Promise<BoardTask> {
  try {
    return toTask(await (await takeHeld(board, id)).complete(result.slice(0, 900)));
  } catch (e) {
    throw asTaskError(e);
  }
}

/** Hold a held task again for another reason, with its lane back on so a worker can take it when that hold lifts. */
export async function reholdTask(board: Board, id: string, lane: string | null, hold: { kind: string; reason: string }): Promise<BoardTask> {
  try {
    const held = await (await takeHeld(board, id)).block(hold.reason.slice(0, 900), { kind: hold.kind });
    if (lane) await board.label(id, { set: { [LABEL.lane]: lane } });
    return toTask(held);
  } catch (e) {
    throw asTaskError(e);
  }
}

/**
 * Send work that waits for a step's task to a person as it is, because that step is not coming (its task failed, was
 * held or was closed). Nothing happens unless the work is held for exactly that task. True when the work moved.
 */
export async function skipStep(board: Board, id: string, stepTask: string, why: string): Promise<boolean> {
  const task = toTask((await readThread(board, id)).message);
  const waits = task.hold?.kind === HOLD.eval ? parseEvalHold(task.hold.reason) : undefined;
  if (!waits || waits.task !== stepTask) return false;
  const said = prose(why.trim().replace(/\.+$/, "").slice(0, 600));
  try {
    await board.reply(id, { text: `The ${waits.step} step could not run on the ${waits.lane} lane: ${said}. The work goes to review without it.`, labels: { [LABEL.relay]: RELAY_MESSAGE.log } });
    await board.reply(id, { text: evalText({ step: waits.step, task: stepTask, lane: waits.lane, verdict: said, ran: false }), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true });
    await reholdTask(board, id, task.lane, { kind: HOLD.review, reason: task.pr?.url ?? `${waits.step} could not run: ${said}` });
    return true;
  } catch (e) {
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
  /** The pull request that was merged; null for a task whose deliverable is its attached outputs. */
  pr_url: string | null;
  merge_sha: string | null;
  branch_deleted: boolean;
}

/**
 * Approve a task in review. With a pull request: squash-merge it, delete its branch and complete the task. The pull
 * request is the one the runner's hold names, and it is merged only if its head is a branch a lane pushed for this
 * task, so nothing written on the board can point an approval at another pull request. With outputs instead (the
 * nodes lane): complete the task.
 */
export async function approveTask(board: Board, github: GitHubClient | undefined, id: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const { task, thread } = await getTask(board, id);
  if (task.state !== "review") throw new TaskError(`${task.id} is ${task.state}, not in review; only a task in review can be approved.`, 409);
  if (!task.pr) {
    const outputs = thread.replies.flatMap((m) => blocksOf<AssetBlock>(m, ASSET_SCHEMA)).length;
    if (!outputs) throw new TaskError(`${task.id} is in review with neither a pull request nor outputs to approve (its hold says: ${task.hold?.reason || "nothing"}).`, 409);
    return { task: await settleTask(board, id, `approved ${outputs} output${outputs === 1 ? "" : "s"}${opts.by ? ` by ${opts.by}` : ""}`), pr_url: null, merge_sha: null, branch_deleted: false };
  }
  if (!github) throw new TaskError("No GitHub credential: log in with gh (CLI) or connect GitHub (site).", 503);
  const { repo, number, url } = task.pr;
  let pull;
  try {
    pull = await github.getPullRequest(repo, number);
  } catch (e) {
    throw new TaskError(`GitHub could not read PR #${number} of ${repo}: ${describeGitHub(e)}`, 502);
  }
  if (!isBranchOf(pull.head_ref, id)) throw new TaskError(`PR #${number} of ${repo} comes from ${pull.head_ref || "an unknown branch"}, which is not a branch relay pushed for ${task.id}; not merging it.`, 409);
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
      await board.reply(id, { text: prose(`Merge of #${number} refused: ${reason}`.slice(0, 900)), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true }).catch(() => undefined);
      throw new TaskError(`GitHub refused to merge #${number}: ${reason}`, 502);
    }
    if (!opts.keepBranch && pull.head_ref) {
      branchDeleted = await github.deleteBranch(repo, pull.head_ref).then(
        () => true,
        () => false, // the merge stands; the branch can go by hand
      );
    }
  }
  return { task: await settleTask(board, id, `merged ${repo}#${number}${sha ? ` in ${sha.slice(0, 7)}` : ""}`), pr_url: url, merge_sha: sha, branch_deleted: branchDeleted };
}

/** Send a task in review back: the note goes in the thread (and on the pull request when GitHub is at hand), and the hold is lifted. */
export async function requestChanges(board: Board, github: GitHubClient | undefined, id: string, note: string): Promise<BoardTask> {
  const text = note.trim();
  if (!text) throw new TaskError("a note is required: say what to change.", 400);
  if (text.length > 6000) throw new TaskError("the note is at most 6,000 characters.", 400);
  const { task } = await getTask(board, id);
  if (task.state !== "review") throw new TaskError(`${task.id} is ${task.state}, not in review; only a task in review can be sent back.`, 409);
  try {
    await board.reply(id, { text: prose(text), labels: { [LABEL.relay]: RELAY_MESSAGE.note } });
    if (github && task.pr) await github.createComment(task.pr.repo, task.pr.number, `**Changes requested** (relay task ${task.id})\n\n${text}`).catch(() => undefined);
    return toTask(await board.tasks.unblock(id));
  } catch (e) {
    throw asTaskError(e);
  }
}

/**
 * Lift the injection gate's hold for the text as it stands: a `relay-release` block with that text's digest, then the
 * unblock. The board lets only the task's owner, or someone who manages its channel, lift a hold; the block is what
 * tells the next run which text a person read.
 */
export async function releaseTask(board: Board, id: string): Promise<BoardTask> {
  const thread = await readThread(board, id);
  const task = toTask(thread.message);
  if (task.state !== "held") throw new TaskError(`${task.id} is ${task.state}, not held; only a task the gate holds can be released.`, 409);
  try {
    await board.reply(id, { text: releaseText({ digest: (await gateInput(board, thread)).digest }), labels: { [LABEL.relay]: RELAY_MESSAGE.log }, noSync: true });
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
  if (task.state === "running") throw new TaskError(`${task.id} is running on ${task.claim?.actor ?? "a worker"}${task.claim ? ` until ${task.claim.until}` : ""}; it returns to the queue by itself if that worker stops renewing. relay task close stops the run.`, 409);
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
  /** What happened on GitHub, best effort: the task's own open pull requests and the issue it answered. */
  github: { pr_closed: boolean; issue_closed: boolean; error?: string };
  /** Step tasks that were looking at this one, called off with it. */
  canceled: string[];
  /** The work this task was a step of, when closing it sent that work to review without the step. */
  to_review: string | null;
}

/**
 * Finish a task without a merge: canceled on the board with the reason, which also ends a run in progress at its
 * next look. Work that was waiting for this task (it was a step's task, such as an eval) goes to review without it. On GitHub, its open pull requests (the ones whose head is a branch a lane pushed for this task) are closed
 * and their branches deleted, and the issue its own text names is closed. Step tasks that were looking at it are called off.
 */
export async function closeTask(board: Board, github: GitHubClient | undefined, id: string, opts: { reason?: string } = {}): Promise<CloseResult> {
  const reason = (opts.reason ?? "").trim();
  if (reason.length > 900) throw new TaskError("the reason is at most 900 characters.", 400);
  const { task, thread } = await getTask(board, id);
  if (task.state === "done" || task.state === "closed") throw new TaskError(`${task.id} is already ${task.state}.`, 409);
  let canceled;
  const dependents: string[] = [];
  let toReview: string | null = null;
  try {
    canceled = toTask(await board.tasks.cancel(id, reason || "closed without a merge"));
    for (const other of task.project ? await listTasks(board, { project: task.project }) : []) {
      if (other.evaluates !== id) continue;
      await board.tasks.cancel(other.id, `the task it was to look at, ${id}, was closed`);
      dependents.push(other.id);
    }
    if (task.evaluates) toReview = (await skipStep(board, task.evaluates, id, `its task was closed${reason ? ` (${reason})` : ""}`).catch(() => false)) ? task.evaluates : null;
  } catch (e) {
    throw asTaskError(e);
  }
  const gh: CloseResult["github"] = { pr_closed: false, issue_closed: false };
  if (github) {
    const comment = `Closed by relay without a merge (task ${task.id})${reason ? `: ${reason}` : "."}`;
    // every pull request the thread names is a candidate; only one whose head is this task's branch is touched
    const named = [task.pr, ...thread.replies.flatMap((m) => blocksOf<RunBlock>(m, RUN_SCHEMA)).map((r) => r.pr)].filter((p): p is NonNullable<BoardTask["pr"]> => !!p);
    try {
      for (const pr of new Map(named.map((p) => [p.url, p])).values()) {
        const pull = await github.getPullRequest(pr.repo, pr.number);
        if (pull.state !== "open" || pull.merged || !isBranchOf(pull.head_ref, id)) continue;
        await github.createComment(pr.repo, pr.number, comment);
        await github.request("PATCH", `/repos/${pr.repo}/pulls/${pr.number}`, { state: "closed" });
        gh.pr_closed = true;
        // the commits stay reachable through the pull request, which can restore the branch
        await github.deleteBranch(pr.repo, pull.head_ref).catch(() => undefined);
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
  return { task: canceled, github: gh, canceled: dependents, to_review: toReview };
}
