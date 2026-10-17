/**
 * The flow map's vocabulary (DESIGN.md, "Visuals"): a task's *station* is where its pill sits on the transit map.
 * Stations are coarser than feed events and finer than task states: `review` splits into PR, Preview and Review so
 * the operator sees whether a PR is waiting on Vercel, on a first look, or on a decision somebody has started.
 *
 *   queued  -> Queue        claimed -> Claimed        running -> Running
 *   review  -> PR       while no preview is ready (none, building, or failed)
 *           -> Preview  once the preview is ready and nobody has weighed in
 *           -> Review   once a person or bot engaged: a pr.review on GitHub, or relay's merge was refused
 *                       (task.merge_failed) after an approval, so a decision sits with someone
 *   done    -> Merged       failed  -> Failed (the siding under Running)
 *
 * `since` is when the task entered that station: the timestamp of the last event that moved it there, so the dwell
 * timer under a pill says how long it has waited at *this* stop rather than how long the task has existed.
 *
 * Pure: no database, no React. `lib/data-db.ts` and `lib/data-mock.ts` call it; `test/flow.test.ts` covers it.
 */
import type { PreviewState, TaskState } from "@relay/core";

export type Station = "Queue" | "Claimed" | "Running" | "PR" | "Preview" | "Review" | "Merged" | "Failed";

/** The line, left to right. Failed is the siding below Running and is not on the line. */
export const STATIONS: readonly Exclude<Station, "Failed">[] = ["Queue", "Claimed", "Running", "PR", "Preview", "Review", "Merged"];

/** The worker lanes, in the order their lines are drawn. Anything else (`*-cloud`) rides the dashed cloud line. */
export const FLOW_LANES = ["claude", "codex", "grok"] as const;
export type FlowLane = (typeof FLOW_LANES)[number] | "cloud";

export const laneOf = (lane: string | null | undefined): FlowLane => (FLOW_LANES.includes(lane as (typeof FLOW_LANES)[number]) ? (lane as FlowLane) : "cloud");

export interface FlowProject {
  slug: string;
  repo: string;
}

export interface FlowWorker {
  name: string;
  lanes: string[];
  state: "online" | "idle" | "offline";
  current: { task_id: string } | null;
  last_seen: string;
}

export interface FlowTask {
  /** "<owner>/<repo>#<n>" */
  id: string;
  project: string;
  repo: string;
  issue: number;
  title: string;
  lane: string | null;
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
  /** The run's error line, for the failed siding's hover. */
  error?: string;
  /** Folded cost equivalent, when any step.usage landed. */
  cost?: number | null;
}

export interface FlowSnapshot {
  ts: string;
  projects: FlowProject[];
  workers: FlowWorker[];
  tasks: FlowTask[];
}

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

const QUEUE_KINDS = new Set(["issue.labeled", "issue.opened", "task.created", "pr.closed", "task.changes_requested", "task.requeued"]);
const PUSH_KINDS = new Set(["pr.opened"]);

/**
 * Which station a task sits at. `review` is split by the preview and by whether someone has engaged since the last
 * push (pr.opened or a run.finished that opened the PR): a `pr.review` or a `task.merge_failed` after that push
 * means a person or bot holds the decision.
 */
export function stationOf(task: StationInput, events: StationEvent[] = []): Station {
  switch (task.state) {
    case "queued":
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
export const IN_MOTION: ReadonlySet<TaskState> = new Set<TaskState>(["queued", "claimed", "running", "review"]);

/** The error line of a failed task, from its last run.failed (summary) or the failed run.finished. */
export function failureLine(events: Array<StationEvent & { summary?: string }>): string | undefined {
  let best: (StationEvent & { summary?: string }) | undefined;
  for (const e of events) if ((e.kind === "run.failed" || finishedBad(e)) && (!best || e.ts > best.ts)) best = e;
  if (!best) return undefined;
  const err = typeof best.payload?.error === "string" ? (best.payload.error as string) : null;
  return err ?? best.summary ?? undefined;
}

/** "12s", "3m", "1h 12m", "2d 3h": how long a pill has sat at its station. Client-side, relative. */
export function fmtDwell(since: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
