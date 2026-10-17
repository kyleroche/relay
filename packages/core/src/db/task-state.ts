/**
 * The task state cache (migration 010). The feed is the source of truth and `deriveTaskStatus` + `deriveStation` the
 * only derivation; this module runs that fold for ONE task after a write that can change it and stores the result on
 * the task row (`state`, `station`, `since`, `pr`, `pr_url`, `preview_state`, `preview_url`, `runner`, `last_error`,
 * `cost`, `title`). Readers that used to fold every task on every call (the flow map's snapshot, the tasks list) read
 * the columns in one query instead.
 *
 * Who calls `refreshTaskState`: `writeEvent` for a row that names a task (repo + issue, or a `preview.*` row matched
 * by PR or branch), `createTask`, and the claim writes in db/workers.ts (`claimNext`, `releaseClaim`, `expireLeases`).
 * `approveTask`, `requestChanges` and `requeueTask` change a task only through those writes, so they are covered.
 * `backfillTaskState` fills rows whose cache was never written: the migration runner calls it once after 010 lands,
 * and the readers fill any `state IS NULL` row they meet (a row inserted by an older process).
 */
import { type Db, iso, num } from "./client.ts";
import type { EventRow } from "./events.ts";
import { deriveTaskStatus, taskClaims, taskEvents, taskId, toTask, TASK_COLS, type ClaimLike, type PreviewState, type TaskRow, type TaskState } from "./tasks.ts";
import { deriveStation, failureLine, FLOW_DONE_MS, FLOW_FAILED_MS, taskTitle, type Station } from "../tasks/station.ts";

/** The cached columns, as `materializeTask` computes them. */
export interface TaskStateCache {
  state: TaskState;
  station: Station;
  /** ISO time the task entered `station`. */
  since: string;
  pr: number | null;
  pr_url: string | null;
  preview_state: PreviewState;
  preview_url: string | null;
  /** `runner:<name>` of the worker on it, when one is. */
  runner: string | null;
  /** The latest run.failed line, while the task is failed. */
  last_error: string | null;
  /** Folded cost equivalent of the task's step.usage rows, when any landed. */
  cost: number | null;
  /** The title the feed supplied, when the row had none; null when nothing names the issue. */
  title: string | null;
}

/** The fold, pure: what `refreshTaskState` writes for a task given its events and claims. */
export function materializeTask(task: TaskRow, events: EventRow[], claims: ClaimLike[], now: number = Date.now()): TaskStateCache {
  const status = deriveTaskStatus(task, events, claims, now);
  const latest = [...claims].sort((a, b) => a.claimed_at.localeCompare(b.claimed_at)).at(-1);
  const claimedAt = latest && !latest.released_at && new Date(latest.lease_until).getTime() > now ? latest.claimed_at : null;
  const { station, since } = deriveStation({ ...status, created_at: task.created_at }, events, { claimedAt, now });
  const title = taskTitle(task, events);
  return {
    state: status.state,
    station,
    since,
    pr: status.pr,
    pr_url: status.pr_url,
    preview_state: status.preview_state,
    preview_url: status.preview_url,
    runner: status.runner,
    last_error: status.state === "failed" ? failureLine(events) ?? null : null,
    cost: status.usage?.cost_equiv ?? null,
    title: title === `#${task.issue}` ? null : title,
  };
}

/** Fold one task and write the cache. Undefined when no such task row exists (an event about an issue relay does not track). */
export async function refreshTaskState(db: Db, id: string, now: number = Date.now()): Promise<TaskStateCache | undefined> {
  const r = await db.query(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [id]);
  if (!r[0]) return undefined;
  const task = toTask(r[0]);
  const [events, claims] = await Promise.all([taskEvents(db, task), taskClaims(db, task.id)]);
  const m = materializeTask(task, events, claims, now);
  await db.query(
    `UPDATE tasks SET state = $2, station = $3, since = $4::timestamptz, pr = $5, pr_url = $6, preview_state = $7, preview_url = $8, runner = $9,
                      last_error = $10, cost = $11, title = coalesce(title, $12), state_updated_at = $13::timestamptz
     WHERE id = $1`,
    [id, m.state, m.station, m.since, m.pr, m.pr_url, m.preview_state, m.preview_url, m.runner, m.last_error, m.cost, m.title, new Date(now).toISOString()],
  );
  return m;
}

/** `relay/<lane>-<issue>` or `relay/<issue>-<lane>`: the issue number a worker's branch names. */
const BRANCH_ISSUE = /^relay\/(?:[a-z][a-z0-9-]*-(\d+)|(\d+)-[a-z][a-z0-9-]*)(?:$|[-/])/;

/**
 * Refresh every task a just-written event can change. A row with an issue number names its task directly (by repo,
 * or by project when the repo is unknown). A `preview.*` row without one (Vercel knows the PR and the ref, GitHub's
 * deployment_status only the ref) is matched the way `taskEvents` matches it: the PR one of the task's events carries,
 * or the task's branch. Anything else (a model call, a bot's note) touches no task and costs no query.
 */
export async function refreshTaskForEvent(db: Db, e: Pick<EventRow, "kind" | "repo" | "project" | "issue" | "pr" | "payload">, now: number = Date.now()): Promise<string[]> {
  const ids = new Set<string>();
  if (e.issue != null) {
    if (e.repo) ids.add(taskId(e.repo, e.issue));
    else if (e.project) {
      const r = await db.query<{ id: string }>("SELECT id FROM tasks WHERE project = $1 AND issue = $2", [e.project, e.issue]);
      for (const x of r) ids.add(x.id);
    }
  } else if (e.kind.startsWith("preview.") && e.repo) {
    const ref = typeof e.payload.ref === "string" ? e.payload.ref : typeof e.payload.branch === "string" ? e.payload.branch : null;
    const m = ref ? BRANCH_ISSUE.exec(ref) : null;
    if (m) ids.add(taskId(e.repo, Number(m[1] ?? m[2])));
    if (e.pr != null || ref) {
      const r = await db.query<{ issue: unknown }>(
        `SELECT DISTINCT issue FROM events WHERE repo = $1 AND issue IS NOT NULL AND kind NOT LIKE 'preview.%'
           AND (($2::int IS NOT NULL AND pr = $2::int) OR ($3::text IS NOT NULL AND payload->>'branch' = $3::text))`,
        [e.repo, e.pr ?? null, ref],
      );
      for (const x of r) ids.add(taskId(e.repo, num(x.issue)));
    }
  }
  const refreshed: string[] = [];
  for (const id of ids) if (await refreshTaskState(db, id, now)) refreshed.push(id);
  return refreshed;
}

/** Fold and cache every task whose cache is empty (`all` recomputes every row). Returns how many rows were written. */
export async function backfillTaskState(db: Db, opts: { all?: boolean; now?: number } = {}): Promise<number> {
  const r = await db.query<{ id: string }>(`SELECT id FROM tasks ${opts.all ? "" : "WHERE state IS NULL"} ORDER BY created_at ASC, id ASC`);
  for (const x of r) await refreshTaskState(db, x.id, opts.now);
  return r.length;
}

/** One row of the flow map's snapshot query: the task row plus its cache, and the project's repo for the stop. */
export interface FlowRow extends TaskRow, TaskStateCache {
  /** The repo of the task's project row, null when the project row is gone. */
  project_repo: string | null;
}

const toFlowRow = (r: Record<string, unknown>): FlowRow => ({
  ...toTask(r),
  state: r.state as TaskState,
  station: r.station as Station,
  since: iso(r.since) ?? "",
  pr: r.pr == null ? null : num(r.pr),
  pr_url: (r.pr_url as string | null) ?? null,
  preview_state: ((r.preview_state as string | null) ?? "none") as PreviewState,
  preview_url: (r.preview_url as string | null) ?? null,
  runner: (r.runner as string | null) ?? null,
  last_error: (r.last_error as string | null) ?? null,
  cost: r.cost == null ? null : num(r.cost),
  project_repo: (r.project_repo as string | null) ?? null,
});

/**
 * The tasks the flow map draws, in one query over the cache: everything in motion (queued, held, claimed, running, review),
 * done tasks for `FLOW_DONE_MS` after they reached Merged (so a client sees them arrive and fade) and failed ones for
 * `FLOW_FAILED_MS` (the siding shows what stalled today without turning into an archive). A row whose cache is empty
 * is filled in and the query run again, so the first snapshot after the migration is complete. Lease expiry is the
 * caller's: run `expireLeases` first when the snapshot should not show a vanished worker's lease as live.
 */
export async function flowTasks(db: Db, opts: { now?: number; limit?: number } = {}): Promise<FlowRow[]> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 200;
  const select = async () =>
    db.query(
      `SELECT ${TASK_COLS.split(", ")
        .map((c) => `t.${c}`)
        .join(", ")}, t.state, t.station, t.since, t.pr, t.pr_url, t.preview_state, t.preview_url, t.runner, t.last_error, t.cost, p.repo AS project_repo
       FROM tasks t LEFT JOIN projects p ON p.slug = t.project
       WHERE t.state IS NULL
          OR t.state IN ('queued', 'held', 'claimed', 'running', 'review')
          OR (t.state = 'done' AND t.since > $1::timestamptz)
          OR (t.state = 'failed' AND t.since > $2::timestamptz)
       ORDER BY t.created_at DESC, t.id DESC LIMIT $3`,
      [new Date(now - FLOW_DONE_MS).toISOString(), new Date(now - FLOW_FAILED_MS).toISOString(), limit],
    );
  let rows = await select();
  const empty = rows.filter((r) => r.state == null);
  if (empty.length) {
    for (const r of empty) await refreshTaskState(db, r.id as string, now);
    rows = await select();
  }
  return rows.filter((r) => r.state != null).map(toFlowRow);
}
