/**
 * The flow map's vocabulary (apps/web/DESIGN.md, "Visuals"): a task's *station* is where its pill sits on the transit
 * map. Stations are coarser than feed events and finer than task states: `review` splits into PR, Preview and Review
 * so the operator sees whether a PR is waiting on Vercel, on a first look, or on a decision somebody has started.
 *
 *   queued  -> Queue        claimed -> Claimed        running -> Running
 *   held    -> Queue        (the injection gate holds it at the first stop; the flow task carries `held: true`)
 *   review  -> PR       while no preview is ready (none, building, or failed)
 *           -> Preview  once the preview is ready and nobody has weighed in
 *           -> Review   once a person or bot engaged: a pr.review on GitHub, or relay's merge was refused
 *                       (task.merge_failed) after an approval, so a decision sits with someone
 *   done    -> Merged       failed  -> Failed (the siding under Running)
 *
 * `since` is when the task entered that station: the timestamp of the last event that moved it there, so the dwell
 * timer under a pill says how long it has waited at *this* stop rather than how long the task has existed.
 *
 * Pure: no database, no React, type-only imports, so the web's client bundle can import it through
 * `@relay/core/tasks/station.ts`. `db/task-state.ts` runs it after every write and caches the result on the task row;
 * apps/web/lib/flow.ts re-exports it under the same names.
 */
import type { PreviewState, TaskState } from "../db/tasks.ts";

export type Station = "Queue" | "Claimed" | "Running" | "PR" | "Preview" | "Review" | "Merged" | "Failed";

/** The line, left to right. Failed is the siding below Running and is not on the line. */
export const STATIONS: readonly Exclude<Station, "Failed">[] = ["Queue", "Claimed", "Running", "PR", "Preview", "Review", "Merged"];
export const isStation = (s: string): s is Station => s === "Failed" || (STATIONS as readonly string[]).includes(s);

/** The worker lanes, in the order their lines are drawn. Anything else (`*-cloud`) rides the dashed cloud line. */
export const FLOW_LANES = ["claude", "codex", "grok"] as const;
export type FlowLane = (typeof FLOW_LANES)[number] | "cloud";

export const laneOf = (lane: string | null | undefined): FlowLane => (FLOW_LANES.includes(lane as (typeof FLOW_LANES)[number]) ? (lane as FlowLane) : "cloud");

/** The slice of a task view the derivation reads. */
export interface StationInput {
  state: TaskState;
  preview_state: PreviewState;
  preview_url?: string | null;
  review?: { decided: "approved" | "changes_requested" | null; at: string | null } | null;
  merged_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** The slice of a feed row the derivation reads. */
export interface StationEvent {
  kind: string;
  ts: string;
  url?: string | null;
  summary?: string;
  payload?: Record<string, unknown>;
}

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);
const conclusionOf = (e: StationEvent): string => (typeof e.payload?.conclusion === "string" ? (e.payload.conclusion as string) : "");
const finishedOk = (e: StationEvent): boolean => e.kind === "run.finished" && !FAILED_CONCLUSIONS.has(conclusionOf(e));
const finishedBad = (e: StationEvent): boolean => e.kind === "run.finished" && FAILED_CONCLUSIONS.has(conclusionOf(e));

/** Latest ts among the events a predicate picks, or null. Events may arrive in any order. */
function latest(events: StationEvent[], pick: (e: StationEvent) => boolean): string | null {
  let best: string | null = null;
  for (const e of events) if (pick(e) && (best === null || e.ts > best)) best = e.ts;
  return best;
}

const QUEUE_KINDS = new Set(["issue.labeled", "issue.opened", "task.created", "pr.closed", "task.changes_requested", "task.requeued", "task.held", "task.released"]);
const PUSH_KINDS = new Set(["pr.opened"]);

/**
 * Which station a task sits at. `review` is split by the preview and by whether someone has engaged since the last
 * push (pr.opened or a run.finished that opened the PR): a `pr.review` or a `task.merge_failed` after that push
 * means a person or bot holds the decision.
 */
export function stationOf(task: StationInput, events: StationEvent[] = []): Station {
  switch (task.state) {
    case "queued":
    case "held":
      return "Queue";
    case "claimed":
      return "Claimed";
    case "running":
      return "Running";
    case "done":
      return "Merged";
    case "failed":
      return "Failed";
    case "review": {
      const push = latest(events, (e) => PUSH_KINDS.has(e.kind) || finishedOk(e));
      const engaged = latest(events, (e) => e.kind === "pr.review" || e.kind === "task.merge_failed");
      if (engaged && (!push || engaged >= push)) return "Review";
      return task.preview_state === "ready" ? "Preview" : "PR";
    }
  }
}

/**
 * When the task entered `station`: the latest event that moves a task there, else the fallbacks (`claimedAt` for a
 * live claim, which the feed does not record; then updated_at, created_at, `now`).
 */
export function stationSince(task: StationInput, station: Station, events: StationEvent[] = [], opts: { claimedAt?: string | null; now?: number } = {}): string {
  let ts: string | null = null;
  switch (station) {
    case "Queue":
      ts = latest(events, (e) => QUEUE_KINDS.has(e.kind));
      break;
    case "Claimed":
      ts = opts.claimedAt ?? null;
      break;
    case "Running":
      ts = latest(events, (e) => e.kind === "run.started" || e.kind === "run.dispatched");
      break;
    case "PR":
      ts = latest(events, (e) => PUSH_KINDS.has(e.kind) || finishedOk(e));
      break;
    case "Preview":
      ts = latest(events, (e) => e.kind === "preview.ready" && (!task.preview_url || !e.url || e.url === task.preview_url)) ?? latest(events, (e) => e.kind === "preview.ready");
      break;
    case "Review":
      ts = latest(events, (e) => e.kind === "pr.review" || e.kind === "task.merge_failed");
      break;
    case "Merged":
      ts = task.merged_at ?? latest(events, (e) => e.kind === "pr.merged" || e.kind === "issue.closed" || (e.kind === "task.approved" && e.payload?.merged === true));
      break;
    case "Failed":
      ts = latest(events, (e) => e.kind === "run.failed" || finishedBad(e));
      break;
  }
  return ts ?? task.updated_at ?? task.created_at ?? new Date(opts.now ?? Date.now()).toISOString();
}

export function deriveStation(task: StationInput, events: StationEvent[] = [], opts: { claimedAt?: string | null; now?: number } = {}): { station: Station; since: string } {
  const station = stationOf(task, events);
  return { station, since: stationSince(task, station, events, opts) };
}

/** States drawn on the map. Done tasks ride along briefly (so the client sees them reach Merged and fade); the adapters decide how briefly. */
export const IN_MOTION: ReadonlySet<TaskState> = new Set<TaskState>(["queued", "held", "claimed", "running", "review"]);

/** How long a done task stays on the map after it merged, and a failed one on the siding (`flowTasks` in db/task-state.ts). */
export const FLOW_DONE_MS = 90_000;
export const FLOW_FAILED_MS = 24 * 3_600_000;

/** The error line of a failed task, from its last run.failed (summary) or the failed run.finished. */
export function failureLine(events: StationEvent[]): string | undefined {
  let best: StationEvent | undefined;
  for (const e of events) if ((e.kind === "run.failed" || finishedBad(e)) && (!best || e.ts > best.ts)) best = e;
  if (!best) return undefined;
  const err = typeof best.payload?.error === "string" ? (best.payload.error as string) : null;
  return err ?? best.summary ?? undefined;
}

/**
 * The issue title: the task row's own when it has one, else the rows that carry it (issue.opened's summary,
 * task.created's "<id>: <title>", the PR title without its "(#n)"), else "#n".
 */
export function taskTitle(task: { id: string; issue: number; title?: string | null }, events: StationEvent[] = []): string {
  if (task.title) return task.title;
  const opened = events.find((e) => e.kind === "issue.opened" && e.summary);
  if (opened?.summary) return opened.summary;
  const created = events.find((e) => e.kind === "task.created" && e.summary?.startsWith(`${task.id}: `));
  if (created?.summary) return created.summary.slice(task.id.length + 2);
  const pr = events.find((e) => e.kind === "pr.opened" && e.summary);
  if (pr?.summary) return pr.summary.replace(/\s*\(#\d+\)\s*$/, "");
  return `#${task.issue}`;
}
