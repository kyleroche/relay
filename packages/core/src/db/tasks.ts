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
}

export type TaskState = "queued" | "running" | "review" | "done" | "failed";
export const TASK_STATES: readonly TaskState[] = ["queued", "running", "review", "done", "failed"];
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

const cols = "id, project, repo, issue, idempotency_key, created_by, created_at";
const toTask = (r: Record<string, unknown>): TaskRow => ({
  id: r.id as string,
  project: r.project as string,
  repo: r.repo as string,
  issue: num(r.issue),
  idempotency_key: (r.idempotency_key as string | null) ?? null,
  created_by: r.created_by as string,
  created_at: iso(r.created_at) ?? "",
});

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
export async function createTask(db: Db, t: { project: string; repo: string; issue: number; idempotencyKey?: string | null; createdBy: string }): Promise<{ task: TaskRow; created: boolean }> {
  const id = taskId(t.repo, t.issue);
  const key = t.idempotencyKey?.trim() || null;
  if (key) {
    const existing = await findTaskByKey(db, key);
    if (existing) return { task: existing, created: false };
  }
  const r = await db.query(
    `INSERT INTO tasks (id, project, repo, issue, idempotency_key, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING RETURNING ${cols}`,
    [id, t.project, t.repo, t.issue, key, t.createdBy],
  );
  if (r[0]) return { task: toTask(r[0]), created: true };
  const existing = await getTask(db, id);
  if (!existing) throw new Error(`task ${id} could not be created`);
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

/**
 * Fold a task's events, oldest first, into one state. The table in docs/INTEGRATIONS.md is this function:
 *   issue.labeled -> queued          run.started -> running           run.failed -> failed
 *   run.finished  -> failed when payload.conclusion is a failure, else review
 *   pr.opened     -> review          pr.merged, issue.closed -> done  pr.closed (no merge) -> queued
 * A task with no events yet is queued (relay opened the issue with its lane label).
 */
export function deriveTaskStatus(task: Pick<TaskRow, "repo" | "issue">, events: EventRow[]): TaskStatus {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  let state: TaskState = "queued";
  let runner: string | null = null;
  let lane: string | null = null;
  let pr: number | null = null;
  let pr_url: string | null = null;
  for (const e of sorted) {
    if (e.lane) lane = e.lane;
    if (e.pr != null) pr = e.pr;
    switch (e.kind) {
      case "issue.labeled":
        state = "queued";
        break;
      case "run.started":
        state = "running";
        if (e.actor.startsWith("runner:")) runner = e.actor;
        break;
      case "run.failed":
        state = "failed";
        break;
      case "run.finished": {
        const conclusion = typeof e.payload.conclusion === "string" ? e.payload.conclusion : "";
        state = FAILED_CONCLUSIONS.has(conclusion) ? "failed" : "review";
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

/** The derived state of one task. */
export async function taskState(db: Db, task: TaskRow): Promise<TaskStatus> {
  return deriveTaskStatus(task, await taskEvents(db, task));
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
