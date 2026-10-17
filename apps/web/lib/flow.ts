/**
 * The flow map's vocabulary (DESIGN.md, "Visuals"): a task's *station* is where its pill sits on the transit map.
 * The derivation (`stationOf`, `stationSince`, `deriveStation`, `failureLine`, the station and lane constants) lives
 * in `@relay/core` (`packages/core/src/tasks/station.ts`) since the state cache (migration 010) computes it on every
 * write; it is re-exported here under the same names, from the pure module so the client bundle stays free of the
 * database. `lib/data-db.ts` reads the cached stations, `lib/data-mock.ts` scripts them; `test/flow.test.ts` covers
 * the derivation.
 *
 * Pure: no database, no React.
 */
import type { PreviewState, TaskState } from "@relay/core";
import type { Station } from "@relay/core/tasks/station.ts";

export {
  STATIONS,
  FLOW_LANES,
  laneOf,
  stationOf,
  stationSince,
  deriveStation,
  failureLine,
  IN_MOTION,
  FLOW_DONE_MS,
  FLOW_FAILED_MS,
  type Station,
  type FlowLane,
  type StationInput,
  type StationEvent,
} from "@relay/core/tasks/station.ts";

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
  /** When the snapshot was computed; the server memoizes it for a few seconds across viewers (app/api/flow/route.ts). */
  ts: string;
  projects: FlowProject[];
  workers: FlowWorker[];
  tasks: FlowTask[];
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
