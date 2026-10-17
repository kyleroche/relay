/**
 * Tasks are GitHub issues with a relay id. The row holds only identity (project, repo, issue, who created it and the
 * idempotency key); the state a bot asks about is DERIVED from the feed every time, so the table can never disagree
 * with what GitHub and the runners actually did.
 */
import { type Db, iso, num } from "./client.ts";
import { EVENT_COLS, toEvent, type EventRow } from "./events.ts";

export interface TaskRow {
  /** "<owner>/<repo>#<n>" */
  id: string;
  project: string;
  repo: string;
  issue: number;
  idempotency_key: string | null;
  created_by: string;
  created_at: string;
  /** The lane the task was opened with (`agent:<lane>`), when known; the scheduler matches on it. */
  lane: string | null;
}

export type TaskState = "queued" | "claimed" | "running" | "review" | "done" | "failed";
export const TASK_STATES: readonly TaskState[] = ["queued", "claimed", "running", "review", "done", "failed"];
export const isTaskState = (s: string): s is TaskState => (TASK_STATES as readonly string[]).includes(s);

export interface TaskStatus {
  state: TaskState;
  /** `runner:<name>` of the runner that last claimed the task, when one did. */
  runner: string | null;
  lane: string | null;
  pr: number | null;
  pr_url: string | null;
  issue_url: string;
  /** Summary line of the latest event for this task. */
  summary: string | null;
  /** ts and kind of the latest event, or null when the feed has nothing yet. */
  updated_at: string | null;
  last_kind: string | null;
  events: number;
}

export interface TaskView extends TaskRow, TaskStatus {}

export const taskId = (repo: string, issue: number): string => `${repo}#${issue}`;
export const issueUrl = (repo: string, issue: number): string => `https://github.com/${repo}/issues/${issue}`;

/** Parse "<owner>/<repo>#<n>"; undefined for anything else. */
export function parseTaskId(id: string): { repo: string; issue: number } | undefined {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id.trim());
  return m ? { repo: m[1]!, issue: Number(m[2]) } : undefined;
}

const cols = "id, project, repo, issue, idempotency_key, created_by, created_at, lane";
/** Row normaliser shared with the scheduler (db/workers.ts). */
export const toTask = (r: Record<string, unknown>): TaskRow => ({
  id: r.id as string,
  project: r.project as string,
  repo: r.repo as string,
  issue: num(r.issue),
  idempotency_key: (r.idempotency_key as string | null) ?? null,
  created_by: r.created_by as string,
  created_at: iso(r.created_at) ?? "",
  lane: (r.lane as string | null) ?? null,
});
export const TASK_COLS = cols;

export async function findTaskByKey(db: Db, key: string): Promise<TaskRow | undefined> {
  const r = await db.query(`SELECT ${cols} FROM tasks WHERE idempotency_key = $1`, [key]);
  return r[0] ? toTask(r[0]) : undefined;
}

export async function getTask(db: Db, id: string): Promise<TaskRow | undefined> {
  const r = await db.query(`SELECT ${cols} FROM tasks WHERE id = $1`, [id]);
  return r[0] ? toTask(r[0]) : undefined;
}

/**
 * Record a task for an issue. Idempotent twice over: the same (repo, issue) is one row, and a repeated
 * idempotency_key returns the row it created the first time. `created` says whether this call inserted.
 */
export async function createTask(db: Db, t: { project: string; repo: string; issue: number; idempotencyKey?: string | null; createdBy: string; lane?: string | null }): Promise<{ task: TaskRow; created: boolean }> {
  const id = taskId(t.repo, t.issue);
  const key = t.idempotencyKey?.trim() || null;
  if (key) {
    const existing = await findTaskByKey(db, key);
    if (existing) return { task: existing, created: false };
  }
  const r = await db.query(
    `INSERT INTO tasks (id, project, repo, issue, idempotency_key, created_by, lane) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING RETURNING ${cols}`,
    [id, t.project, t.repo, t.issue, key, t.createdBy, t.lane ?? null],
  );
  if (r[0]) return { task: toTask(r[0]), created: true };
  const existing = await getTask(db, id);
  if (!existing) throw new Error(`task ${id} could not be created`);
  // a row opened without a lane (or re-labelled on GitHub) learns it from the caller that knows it
  if (t.lane && existing.lane !== t.lane) {
    await db.query("UPDATE tasks SET lane = $2 WHERE id = $1", [id, t.lane]);
    existing.lane = t.lane;
  }
  return { task: existing, created: false };
}

export async function listTasks(db: Db, opts: { project?: string; limit?: number } = {}): Promise<TaskRow[]> {
  const params: unknown[] = [];
  const where = opts.project ? (params.push(opts.project), `WHERE project = $1`) : "";
  params.push(opts.limit ?? 50);
  const r = await db.query(`SELECT ${cols} FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  return r.map(toTask);
}

/** Conclusions of `run.finished` that mean the lane did not deliver. */
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/** The slice of a claim row the state derivation reads (db/workers.ts holds the full row). */
export interface ClaimLike {
  /** Worker name; `runner:<name>` is its actor in the feed. */
  worker: string;
  lease_until: string;
  claimed_at: string;
  released_at: string | null;
  outcome: string | null;
}

/**
 * Fold a task's events, oldest first, into one state. The table in docs/INTEGRATIONS.md is this function:
 *   issue.labeled -> queued          run.started -> running           run.failed -> failed
 *   run.dispatched -> running (a cloud lane: the vendor's tier has it until its PR opens)
 *   run.finished  -> failed when payload.conclusion is a failure, else review
 *   pr.opened     -> review          pr.merged, issue.closed -> done  pr.closed (no merge) -> queued
 * A task with no events yet is queued (relay opened the issue with its lane label).
 *
 * Claims (docs/WORKERS.md) add one step. A live lease on a queued task makes it `claimed`. A lease that ended
 * (expired or released) after the last run.started, with no run.finished or run.failed since, means the worker
 * vanished mid-run: the task is `queued` again and the next claim starts over from the base branch.
 */
export function deriveTaskStatus(task: Pick<TaskRow, "repo" | "issue">, events: EventRow[], claims: ClaimLike[] = [], now: number = Date.now()): TaskStatus {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  let state: TaskState = "queued";
  let runner: string | null = null;
  let lane: string | null = null;
  let pr: number | null = null;
  let pr_url: string | null = null;
  let lastStart: string | null = null;
  let lastEnd: string | null = null;
  for (const e of sorted) {
    if (e.lane) lane = e.lane;
    if (e.pr != null) pr = e.pr;
    switch (e.kind) {
      case "issue.labeled":
        state = "queued";
        break;
      case "run.started":
        state = "running";
        lastStart = e.ts;
        if (e.actor.startsWith("runner:")) runner = e.actor;
        break;
      case "run.dispatched":
        // a cloud lane: the vendor's hosted tier has the task; its PR (pr.opened) is the next thing relay sees
        state = "running";
        break;
      case "run.failed":
        state = "failed";
        lastEnd = e.ts;
        break;
      case "run.finished": {
        const conclusion = typeof e.payload.conclusion === "string" ? e.payload.conclusion : "";
        state = FAILED_CONCLUSIONS.has(conclusion) ? "failed" : "review";
        lastEnd = e.ts;
        if (e.actor.startsWith("runner:")) runner = e.actor;
        break;
      }
      case "pr.opened":
        state = "review";
        if (e.url) pr_url = e.url;
        break;
      case "pr.merged":
      case "issue.closed":
        state = "done";
        if (e.kind === "pr.merged" && e.url) pr_url = e.url;
        break;
      case "pr.closed":
        state = "queued";
        break;
      default:
        break;
    }
  }
  const latest = [...claims].sort((a, b) => a.claimed_at.localeCompare(b.claimed_at)).at(-1);
  if (latest) {
    const live = !latest.released_at && new Date(latest.lease_until).getTime() > now;
    if (live) {
      if (state === "queued") state = "claimed";
      runner = `runner:${latest.worker}`;
    } else if (state === "running" && lastStart && latest.claimed_at <= lastStart && (!lastEnd || lastEnd < lastStart)) {
      // the worker that started this run lost its lease and never reported: back to the queue
      state = "queued";
    }
  }
  const last = sorted.at(-1);
  if (pr != null && !pr_url) pr_url = `https://github.com/${task.repo}/pull/${pr}`;
  return {
    state,
    runner,
    lane,
    pr,
    pr_url,
    issue_url: issueUrl(task.repo, task.issue),
    summary: last?.summary ?? null,
    updated_at: last?.ts ?? null,
    last_kind: last?.kind ?? null,
    events: sorted.length,
  };
}

/** Every feed row about the task: same repo (or project) and issue number, oldest first. */
export async function taskEvents(db: Db, task: Pick<TaskRow, "repo" | "project" | "issue">): Promise<EventRow[]> {
  const r = await db.query(
    `SELECT ${EVENT_COLS} FROM events WHERE issue = $3 AND (repo = $1 OR (repo IS NULL AND project = $2)) ORDER BY ts ASC, id ASC LIMIT 2000`,
    [task.repo, task.project, task.issue],
  );
  return r.map(toEvent);
}

/** The claims on a task, oldest first, in the shape the derivation reads. */
export async function taskClaims(db: Db, taskId: string): Promise<ClaimLike[]> {
  const r = await db.query(
    `SELECT w.name AS worker, c.lease_until, c.claimed_at, c.released_at, c.outcome FROM claims c JOIN workers w ON w.id = c.worker_id
     WHERE c.task_id = $1 ORDER BY c.claimed_at ASC LIMIT 200`,
    [taskId],
  );
  return r.map((x) => ({ worker: x.worker as string, lease_until: iso(x.lease_until) ?? "", claimed_at: iso(x.claimed_at) ?? "", released_at: iso(x.released_at), outcome: (x.outcome as string | null) ?? null }));
}

/** The derived state of one task. */
export async function taskState(db: Db, task: TaskRow): Promise<TaskStatus> {
  const [events, claims] = await Promise.all([taskEvents(db, task), taskClaims(db, task.id)]);
  return deriveTaskStatus(task, events, claims);
}

export async function taskView(db: Db, task: TaskRow): Promise<TaskView> {
  return { ...task, ...(await taskState(db, task)) };
}

/** Tasks with their derived state, optionally filtered to one state. */
export async function listTaskViews(db: Db, opts: { project?: string; state?: TaskState; limit?: number } = {}): Promise<TaskView[]> {
  const rows = await listTasks(db, { ...(opts.project ? { project: opts.project } : {}), limit: opts.state ? Math.max((opts.limit ?? 50) * 4, 200) : opts.limit ?? 50 });
  const views = await Promise.all(rows.map((t) => taskView(db, t)));
  const filtered = opts.state ? views.filter((v) => v.state === opts.state) : views;
  return filtered.slice(0, opts.limit ?? 50);
}
