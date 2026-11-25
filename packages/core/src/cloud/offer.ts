/**
 * When a task is offered a paid sandbox run, and what one is expected to cost. Pure: the site computes an offer each
 * time it renders a queued task, and nothing is written to make one.
 *
 * The owner's rule is the point of all of it: nothing spends money without the owner saying yes first, and waiting for
 * one of their own machines is the default and needs no action. So an offer is only ever a question, shown when no
 * machine of theirs can take the task now; the answer is a grant (board/tasks.ts `grantTask`), and only a grant starts
 * anything (cloud/start.ts).
 *
 * What the yes covers is narrower than the word "cap" suggests, and whoever asks for it has to say so
 * (`CLOUD_CAP_NOTE`). The cap is kept by relay's own processes: each model call relay starts gets what is left of
 * it. The sandbox's firewall adds the gateway's key to any request for the gateway's coding endpoint, whoever in the
 * microVM sent it, so code a fooled lane runs there can call the gateway outside that count. The only limit on that
 * is a budget on the key itself, at the gateway, which relay can neither set nor read with the deployment's own
 * credentials.
 *
 * Experimental: no paid run has been made against a real sandbox or a real gateway.
 */
import type { BoardTask } from "../board/tasks.ts";
import type { WorkerView } from "../board/workers.ts";
import type { ProjectProfile } from "../steps/profile.ts";
import { ANY_LANE, isCodeLane } from "../tasks/lanes.ts";

/** The lane a paid run uses: the only one with a gateway adapter (work/job.ts, `laneRunner`). */
export const CLOUD_LANE = "claude";

export const CLOUD_AFTER_MINUTES = 15;
export const CLOUD_MAX_CAP_USD = 10;
/** A cap is never suggested below this: less does not finish a task, and what it spent is lost. */
export const CLOUD_MIN_CAP_USD = 1;
/** Past runs needed before their median is called an estimate. */
export const CLOUD_ESTIMATE_MIN_RUNS = 3;

/**
 * What the cap is and is not, in the one sentence every surface that asks for the yes shows beside the amount.
 * It stays true only while the gateway's key is added by the firewall for any process in the sandbox; a key that is
 * this run's alone, with a budget of its own, would make the cap the gateway's to keep.
 */
export const CLOUD_CAP_NOTE =
  "relay stops its own model calls at the cap. Code the run executes inside the sandbox can reach the gateway with the same key, so a run fooled by the task's text could spend more, up to the budget set on that key at the gateway. Set one.";
/** That the path is unproven, wherever it is offered. */
export const CLOUD_EXPERIMENTAL_NOTE = "Experimental: paid runs have not been run against a real sandbox yet.";

export interface CloudLimits {
  /** How long a task is queued before a paid run is offered. */
  afterMinutes: number;
  /** The most a person may approve for one run. */
  maxCapUsd: number;
}

/** The limits a deployment set (`RELAY_CLOUD_AFTER_MINUTES`, `RELAY_CLOUD_MAX_CAP_USD`); a value that is no positive number is the default. */
export function cloudLimits(env: Record<string, string | undefined>): CloudLimits {
  const positive = (v: string | undefined, fallback: number): number => {
    const n = v?.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // core refuses a grant above $1000 (board/tasks.ts), so a larger limit could never be approved
  return { afterMinutes: positive(env.RELAY_CLOUD_AFTER_MINUTES, CLOUD_AFTER_MINUTES), maxCapUsd: Math.min(1000, positive(env.RELAY_CLOUD_MAX_CAP_USD, CLOUD_MAX_CAP_USD)) };
}

export type CloudOffer =
  | { offer: true; waitedMs: number }
  | {
      offer: false;
      /**
       * state: not queued. lane: its lane has no paid adapter. profile: the project's profile could not be read, so
       * nobody knows it allows this. never: the profile says `cloud: never`. served: a worker that is online or idle
       * serves its lane. young: queued for less than the threshold.
       */
      why: "state" | "lane" | "profile" | "never" | "served" | "young";
      detail: string;
    };

/**
 * The workers that run on a person's own subscriptions: every worker but the ones this site started itself. A paid
 * run registers as a worker too (`cloud-<ref>`, written by the site's own principal), and it must not count as a
 * machine that could take the next task for free.
 */
export function subscriptionWorkers<W extends Pick<WorkerView, "by">>(workers: readonly W[], site: { handle?: string | null; principal: string }): W[] {
  return workers.filter((w) => w.by !== site.principal && (!site.handle || w.by !== site.handle));
}

/**
 * Whether to offer a paid run for a task, or why not. `workers` are the subscription workers (`subscriptionWorkers`);
 * `profile` is the project's, undefined when it could not be read. A task's age is counted from when it was opened:
 * the board keeps no "queued since", and a task sent back to the queue is offered at once only when no worker serves
 * its lane anyway.
 */
export function cloudOffer(
  task: Pick<BoardTask, "state" | "lane" | "created_at">,
  workers: ReadonlyArray<Pick<WorkerView, "state" | "lanes">>,
  profile: Pick<ProjectProfile, "cloud"> | undefined,
  now: number,
  limits: CloudLimits,
): CloudOffer {
  if (task.state !== "queued") return { offer: false, why: "state", detail: `the task is ${task.state}, not queued` };
  if (task.lane !== CLOUD_LANE && task.lane !== ANY_LANE) return { offer: false, why: "lane", detail: `a paid run uses the ${CLOUD_LANE} lane; this task is on ${task.lane ?? "no lane"}` };
  if (!profile) return { offer: false, why: "profile", detail: "the project's profile could not be read, so it is not known to allow a paid run" };
  if (profile.cloud === "never") return { offer: false, why: "never", detail: "the project's profile says cloud: never" };
  const live = workers.filter((w) => w.state !== "offline").flatMap((w) => w.lanes);
  const taker = task.lane === ANY_LANE ? live.find(isCodeLane) : live.find((l) => l === task.lane);
  if (taker) return { offer: false, why: "served", detail: `a worker that is online or idle serves the ${taker} lane` };
  const waitedMs = now - new Date(task.created_at).getTime();
  if (!(waitedMs >= limits.afterMinutes * 60_000)) return { offer: false, why: "young", detail: `queued for less than ${limits.afterMinutes} minutes` };
  return { offer: true, waitedMs };
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * What a run is expected to cost: the median of what past runs of that project on that lane cost, or null when there
 * are fewer than three to go by. A row with no cost (an unpriced model) says nothing and is left out.
 */
export function estimateUsd(costs: readonly number[]): number | null {
  const known = costs.filter((c) => Number.isFinite(c) && c > 0).sort((a, z) => a - z);
  if (known.length < CLOUD_ESTIMATE_MIN_RUNS) return null;
  const mid = Math.floor(known.length / 2);
  return cents(known.length % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2);
}

/** The cap a person is shown before they edit it: twice the estimate, at least $1, at most the deployment's limit. */
export function defaultCap(estimate: number | null, max: number): number {
  return cents(Math.min(max, Math.max(CLOUD_MIN_CAP_USD, 2 * (estimate ?? 0))));
}

/** Why a cap a person typed cannot be approved, or undefined. */
export function capProblem(cap: number, max: number): string | undefined {
  if (!Number.isFinite(cap) || cap <= 0) return "The cap is a number of US dollars above 0.";
  if (cap > max) return `The cap is at most $${max.toFixed(2)} on this deployment (RELAY_CLOUD_MAX_CAP_USD).`;
  return undefined;
}
