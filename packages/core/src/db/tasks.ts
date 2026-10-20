/**
 * Tasks are GitHub issues with a relay id. The row holds identity (project, repo, issue, who created it and the
 * idempotency key) and the title; the state a bot asks about is DERIVED from the feed by `deriveTaskStatus`, so the
 * table can never disagree with what GitHub and the runners actually did. Since migration 010 the row also carries a
 * CACHE of that fold (`state`, `station`, `since`, the PR, the preview, the runner, and since 012 the asset the task
 * delivered: db/task-state.ts), rewritten after every write that can change the task, so lists and the board read
 * one query instead of folding every history.
 */
import { type Db, iso, num } from "./client.ts";
import { EVENT_COLS, toEvent, type EventRow } from "./events.ts";
import { bumpQueueVersion } from "./queue.ts";
import { refreshTaskState } from "./task-state.ts";

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
  /** The issue title, when the creator or the feed supplied it (`taskTitle` in tasks/station.ts fills the gaps). */
  title: string | null;
}

export type TaskState = "queued" | "held" | "claimed" | "running" | "review" | "done" | "failed";
export const TASK_STATES: readonly TaskState[] = ["queued", "held", "claimed", "running", "review", "done", "failed"];
export const isTaskState = (s: string): s is TaskState => (TASK_STATES as readonly string[]).includes(s);

export type PreviewState = "ready" | "failed" | "building" | "none";

export interface TaskUsage {
  /** step.usage rows folded in (one per worker run). */
  runs: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cost_equiv: number;
  /** Model of the latest run. */
  model: string | null;
  duration_ms: number | null;
}

export interface TaskReview {
  /** The latest decision on the current PR; null while nobody has decided (or after a new run superseded a request). */
  decided: "approved" | "changes_requested" | null;
  by: string | null;
  at: string | null;
  note: string | null;
}

/** The asset a task delivered, as the board and the task page name it; the row itself is in `assets` (db/assets.ts). */
export interface TaskAsset {
  id: string;
  kind: string;
  version: number;
}

export interface TaskStatus {
  state: TaskState;
  /** `runner:<name>` of the runner that last claimed the task, when one did. */
  runner: string | null;
  lane: string | null;
  pr: number | null;
  pr_url: string | null;
  issue_url: string;
  /** The head branch of the run (`relay/<lane>-<issue>`), from run.started or pr.opened; null until a run starts. */
  branch: string | null;
  /** Summary line of the latest event for this task. */
  summary: string | null;
  /** The lane's own summary from the latest run.finished, or null before a run finished. */
  run_summary: string | null;
  usage: TaskUsage | null;
  /** The latest successful deployment of the task's branch (Vercel or GitHub deployment_status), when one matched. */
  preview_url: string | null;
  /** ready: the url is current; building: a push landed after the last deployment; failed: the last build errored; none. */
  preview_state: PreviewState;
  review: TaskReview;
  /** When the PR was merged (pr.merged from GitHub, or task.approved when relay merged it). */
  merged_at: string | null;
  /**
   * The latest asset uploaded on the task's issue (`asset.uploaded`'s asset_id, kind and version), when the
   * deliverable is an asset rather than a pull request (a production task; docs/ARCHITECTURE.md "A task's life");
   * null while nothing was uploaded.
   */
  asset: TaskAsset | null;
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

const cols = "id, project, repo, issue, idempotency_key, created_by, created_at, lane, title";
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
  title: (r.title as string | null) ?? null,
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
 * idempotency_key returns the row it created the first time. `created` says whether this call inserted. A new row
 * gets its state cache written at once (`queued`, at Queue since it was created), so a list sees it without a fold.
 */
export async function createTask(db: Db, t: { project: string; repo: string; issue: number; idempotencyKey?: string | null; createdBy: string; lane?: string | null; title?: string | null }): Promise<{ task: TaskRow; created: boolean }> {
  const id = taskId(t.repo, t.issue);
  const key = t.idempotencyKey?.trim() || null;
  const title = t.title?.trim() || null;
  if (key) {
    const existing = await findTaskByKey(db, key);
    if (existing) return { task: existing, created: false };
  }
  const r = await db.query(
    `INSERT INTO tasks (id, project, repo, issue, idempotency_key, created_by, lane, title) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING RETURNING ${cols}`,
    [id, t.project, t.repo, t.issue, key, t.createdBy, t.lane ?? null, title],
  );
  if (r[0]) {
    await refreshTaskState(db, id);
    await bumpQueueVersion(db); // a new task: idle workers' doorbells ring (docs/WORKERS.md)
    return { task: toTask(r[0]), created: true };
  }
  const existing = await getTask(db, id);
  if (!existing) throw new Error(`task ${id} could not be created`);
  // a row opened without a lane (or re-labelled on GitHub) learns it from the caller that knows it
  if (t.lane && existing.lane !== t.lane) {
    await db.query("UPDATE tasks SET lane = $2 WHERE id = $1", [id, t.lane]);
    existing.lane = t.lane;
    await bumpQueueVersion(db);
  }
  if (title && !existing.title) {
    await db.query("UPDATE tasks SET title = $2 WHERE id = $1", [id, title]);
    existing.title = title;
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

/** The branch a worker pushes for an issue, either spelling (`relay/<lane>-<issue>`, older `relay/<issue>-<lane>`). */
export const relayBranchPattern = (issue: number): RegExp => new RegExp(`^relay/(?:[a-z][a-z0-9-]*-${issue}|${issue}-[a-z][a-z0-9-]*)(?:$|[-/])`);

const payloadStr = (e: EventRow, key: string): string | null => (typeof e.payload[key] === "string" ? (e.payload[key] as string) : null);

/**
 * Does a `preview.*` row belong to this task? The two ingest paths differ: the Vercel webhook knows the PR number and
 * the branch (`githubPrId`, `githubCommitRef`), GitHub's deployment_status knows only the ref. So a deployment counts
 * when its issue is ours, its PR is one of ours, or its ref (payload.ref / payload.branch) is the task's branch.
 */
export function previewMatches(task: Pick<TaskRow, "issue">, e: EventRow, prs: ReadonlySet<number>, branch: string | null): boolean {
  if (!e.kind.startsWith("preview.")) return false;
  if (e.issue != null) return e.issue === task.issue;
  if (e.pr != null && prs.has(e.pr)) return true;
  const ref = payloadStr(e, "ref") ?? payloadStr(e, "branch");
  if (!ref) return false;
  if (branch && ref === branch) return true;
  return relayBranchPattern(task.issue).test(ref);
}

/**
 * Fold a task's events, oldest first, into one state. The table in docs/INTEGRATIONS.md is this function:
 *   issue.labeled -> queued          run.started -> running           run.failed -> failed
 *   run.dispatched -> running (a cloud lane: the vendor's tier has it until its PR opens)
 *   run.finished  -> failed when payload.conclusion is a failure, else review
 *   pr.opened     -> review          pr.merged, issue.closed -> done  pr.closed (no merge) -> queued
 *   task.changes_requested -> queued (the next run addresses the note; docs/ARCHITECTURE.md "A task's life")
 *   task.approved -> done when relay merged the PR itself (payload.merged); pr.merged from GitHub confirms it
 *   task.merge_failed -> stays in review (GitHub refused the merge; the payload says why)
 *   task.requeued -> queued (an operator put it back, perhaps on another lane; tasks/requeue.ts)
 *   task.held -> held (the injection gate flagged the issue text; not claimable until released; tasks/gate.ts)
 *   task.released -> queued (a person or a tokens:write bot released the hold)
 * The asset path, for a task whose deliverable is a media asset on the issue rather than a PR (a production):
 *   asset.uploaded -> review (the asset is `asset`: id, kind, version; a new version answers an earlier rejection)
 *   asset.reviewed -> done when payload.decision is approved (the site closes the issue; issue.closed confirms it),
 *                     queued when rejected (the note is the review, and the next run's brief carries it)
 * Everything applies in timestamp order, so a run.started after a rejection is running, as on the PR path.
 * A task with no events yet is queued (relay opened the issue with its lane label).
 *
 * Claims (docs/WORKERS.md) add one step. A live lease on a queued task makes it `claimed`. A lease that ended
 * (expired or released) after the last run.started, with no run.finished or run.failed since, means the worker
 * vanished mid-run: the task is `queued` again and the next claim starts over from the base branch.
 *
 * Alongside the state: the PR, its branch, the latest preview of that branch (`preview.*` rows matched by issue, PR
 * or ref), the lane's summary and the folded usage, the review decision and when the PR was merged.
 */
export function deriveTaskStatus(task: Pick<TaskRow, "repo" | "issue">, events: EventRow[], claims: ClaimLike[] = [], now: number = Date.now()): TaskStatus {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  let state: TaskState = "queued";
  let runner: string | null = null;
  let lane: string | null = null;
  let pr: number | null = null;
  let pr_url: string | null = null;
  let branch: string | null = null;
  let lastStart: string | null = null;
  let lastEnd: string | null = null;
  let run_summary: string | null = null;
  let usage = null as TaskUsage | null;
  let merged_at: string | null = null;
  let asset: TaskAsset | null = null;
  let review: TaskReview = { decided: null, by: null, at: null, note: null };
  // previews are matched against every PR the task ever had, whichever order the webhooks arrived in
  const prs = new Set<number>();
  for (const e of sorted) if (e.pr != null && !e.kind.startsWith("preview.")) prs.add(e.pr);
  let preview = null as { url: string | null; state: PreviewState; ts: string } | null;
  let lastPush: string | null = null;
  const matched: EventRow[] = [];
  for (const e of sorted) {
    if (e.kind.startsWith("preview.")) {
      if (previewMatches(task, e, prs, branch)) {
        matched.push(e);
        if (e.kind === "preview.ready") preview = { url: e.url, state: "ready", ts: e.ts };
        else if (e.kind === "preview.failed") preview = { url: preview?.url ?? null, state: "failed", ts: e.ts };
      }
      continue;
    }
    const gateRow = e.kind === "step.usage" && e.lane === "gate"; // the injection gate's own call: cost, not a lane or a run
    if (e.lane && !gateRow) lane = e.lane;
    if (e.pr != null) pr = e.pr;
    const b = payloadStr(e, "branch");
    if (b && (e.kind === "run.started" || e.kind === "pr.opened")) branch = b;
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
        if (state === "review") {
          run_summary = e.summary || run_summary;
          lastPush = e.ts;
          // a new run answers an earlier "changes requested"; the new PR state awaits its own decision
          if (review.decided === "changes_requested") review = { decided: null, by: null, at: null, note: null };
        }
        break;
      }
      case "step.usage":
        usage = {
          runs: (usage?.runs ?? 0) + (gateRow ? 0 : 1),
          tokens_in: (usage?.tokens_in ?? 0) + e.tokens_in,
          tokens_out: (usage?.tokens_out ?? 0) + e.tokens_out,
          cache_read: (usage?.cache_read ?? 0) + e.cache_read,
          cost_equiv: Math.round(((usage?.cost_equiv ?? 0) + e.cost_equiv) * 1e6) / 1e6,
          model: gateRow ? usage?.model ?? null : e.model ?? usage?.model ?? null,
          duration_ms: gateRow ? usage?.duration_ms ?? null : e.duration_ms ?? usage?.duration_ms ?? null,
        };
        break;
      case "pr.opened":
        state = "review";
        if (e.url) pr_url = e.url;
        lastPush = e.ts;
        break;
      case "pr.merged":
      case "issue.closed":
        state = "done";
        if (e.kind === "pr.merged") {
          if (e.url) pr_url = e.url;
          merged_at = merged_at ?? e.ts; // relay's own task.approved, when it merged, already holds the moment
        }
        break;
      case "pr.closed":
        state = "queued";
        break;
      case "task.approved":
        review = { decided: "approved", by: e.actor, at: e.ts, note: null };
        if (e.payload.merged === true) {
          // relay merged the PR itself: the merge sha is in hand, GitHub's pr.merged only confirms it
          state = "done";
          merged_at = merged_at ?? e.ts;
          if (e.url) pr_url = e.url;
        }
        break;
      case "task.changes_requested":
        review = { decided: "changes_requested", by: e.actor, at: e.ts, note: payloadStr(e, "note") };
        state = "queued";
        break;
      case "task.merge_failed":
        // GitHub refused the merge; the task stays where it was (review) and the payload says why
        break;
      case "task.requeued":
        // an operator put the task back in the queue (and perhaps on another lane); the next claim starts over
        state = "queued";
        lastEnd = e.ts; // a run that was in flight is over as far as relay is concerned
        break;
      case "task.held":
        // the injection gate flagged the text (tasks/gate.ts): the worker gave its claim back and nobody may claim again until a release
        state = "held";
        lastEnd = e.ts;
        break;
      case "task.released":
        state = "queued";
        break;
      case "asset.uploaded": {
        // the deliverable landed in the library (db/assets.ts): the task waits for a decision on it, like a PR
        const id = payloadStr(e, "asset_id");
        const version = Number(e.payload.version);
        if (id) asset = { id, kind: payloadStr(e, "kind") ?? "file", version: Number.isFinite(version) && version > 0 ? version : 1 };
        state = "review";
        if (review.decided === "changes_requested") review = { decided: null, by: null, at: null, note: null }; // a new version answers the rejection
        break;
      }
      case "asset.reviewed": {
        const decision = payloadStr(e, "decision");
        if (decision === "approved") {
          state = "done";
          review = { decided: "approved", by: e.actor, at: e.ts, note: payloadStr(e, "note") };
        } else if (decision === "rejected") {
          state = "queued";
          review = { decided: "changes_requested", by: e.actor, at: e.ts, note: payloadStr(e, "note") };
        }
        break;
      }
      default:
        break;
    }
  }
  let preview_state: PreviewState = preview ? preview.state : "none";
  if (preview && preview.state === "ready" && lastPush && lastPush > preview.ts) preview_state = "building";
  if (!branch && lane && lastStart) branch = `relay/${lane}-${task.issue}`;
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
  const own = sorted.filter((e) => !e.kind.startsWith("preview.") || matched.includes(e));
  const last = own.at(-1);
  if (pr != null && !pr_url) pr_url = `https://github.com/${task.repo}/pull/${pr}`;
  return {
    state,
    runner,
    lane,
    pr,
    pr_url,
    issue_url: issueUrl(task.repo, task.issue),
    branch,
    summary: last?.summary ?? null,
    run_summary,
    usage,
    preview_url: preview?.url ?? null,
    preview_state,
    review,
    merged_at,
    asset,
    updated_at: last?.ts ?? null,
    last_kind: last?.kind ?? null,
    events: own.length,
  };
}

/**
 * Every feed row about the task, oldest first: same repo (or project) and issue number, plus the `preview.*` rows
 * for the task's branch that arrived without an issue number (Vercel knows the PR and the ref, GitHub's
 * deployment_status only the ref). `deriveTaskStatus` matches those again in memory.
 */
export async function taskEvents(db: Db, task: Pick<TaskRow, "repo" | "project" | "issue">): Promise<EventRow[]> {
  const r = await db.query(
    `SELECT ${EVENT_COLS} FROM events
     WHERE (repo = $1 OR (repo IS NULL AND project = $2))
       AND (issue = $3
            OR (kind LIKE 'preview.%' AND issue IS NULL
                AND ((pr IS NOT NULL AND pr IN (SELECT e2.pr FROM events e2 WHERE e2.repo = $1 AND e2.issue = $3 AND e2.pr IS NOT NULL))
                     OR coalesce(payload->>'ref', payload->>'branch', '') ~ $4)))
     ORDER BY ts ASC, id ASC LIMIT 2000`,
    [task.repo, task.project, task.issue, relayBranchPattern(task.issue).source],
  );
  return r.map(toEvent);
}

/** The claims on a task, oldest first, in the shape the derivation reads. A forgotten worker's claims stay (its id stands in for the name). */
export async function taskClaims(db: Db, taskId: string): Promise<ClaimLike[]> {
  const r = await db.query(
    `SELECT coalesce(w.name, c.worker_id) AS worker, c.lease_until, c.claimed_at, c.released_at, c.outcome FROM claims c LEFT JOIN workers w ON w.id = c.worker_id
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

/**
 * Tasks with their derived state, optionally filtered to one state. The filter comes from the cached `state` column
 * (db/task-state.ts), so only the rows returned are folded instead of four pages of candidates; a row whose cache was
 * never written (`state IS NULL`, before the backfill ran) is folded and filled in on the way.
 */
export async function listTaskViews(db: Db, opts: { project?: string; state?: TaskState; limit?: number } = {}): Promise<TaskView[]> {
  const limit = opts.limit ?? 50;
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.project) {
    params.push(opts.project);
    where.push(`project = $${params.length}`);
  }
  if (opts.state) {
    params.push(opts.state);
    where.push(`(state = $${params.length} OR state IS NULL)`);
  }
  params.push(limit);
  const rows = await db.query(`SELECT ${cols}, state FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const views = await Promise.all(
    rows.map(async (r) => {
      const task = toTask(r);
      if (r.state == null) await refreshTaskState(db, task.id); // first read after the migration: fill the cache
      return taskView(db, task);
    }),
  );
  return opts.state ? views.filter((v) => v.state === opts.state) : views;
}
