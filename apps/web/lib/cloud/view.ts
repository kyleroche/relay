/**
 * What a page shows about a paid sandbox run for a queued task, computed from the board each time it renders: the
 * offer ("Waiting for a worker", with what a run is expected to cost), or the run a person already approved and where
 * it stands. Nothing is written to make an offer.
 *
 * An offer needs every one of: the task is queued on a lane a paid run serves, no worker on a person's own
 * subscriptions that is online or idle serves that lane, it has waited longer than the deployment's threshold, the
 * project's profile does not say `cloud: never`, and the deployment is set up for paid runs.
 */
import type { ThreadView } from "@vercel/board";
import { board, CLOUD_APPROVED, CLOUD_LABEL, CLOUD_LANE, cloudGrantOf, cloudMarksOf, cloudOffer, cloudStart, defaultCap, estimateUsd, subscriptionWorkers } from "@relay/core";
import { getFeed } from "../data.ts";
import { projectProfile } from "../profile.ts";
import { cloudConfig, cloudProblem } from "./config.ts";

export interface CloudOfferView {
  waitedMs: number;
  /** The median of past runs of this project on the lane a paid run uses; null with fewer than three. */
  estimateUsd: number | null;
  /** The cap the person is shown first. */
  capUsd: number;
  maxCapUsd: number;
}

export interface CloudApprovedView {
  capUsd: number;
  /** pending: starts at the site's next look. starting: a sandbox is coming up. ended: the run started and the task is queued again. gave-up: no start came up. */
  status: "pending" | "starting" | "ended" | "gave-up";
  /** Why the last start did not come up. */
  why?: string;
}

export interface CloudView {
  approved?: CloudApprovedView;
  offer?: CloudOfferView;
}

const ESTIMATE_TTL_MS = 60_000;
const ESTIMATE_ROWS = 200;

declare global {
  // eslint-disable-next-line no-var
  var __relayCloudEstimates: Map<string, { at: number; read: Promise<number | null> }> | undefined;
}

/**
 * What a paid run of a project is expected to cost: the median `cost_equiv` of its past `step.usage` rows of a run
 * on the claude lane, from relay's feed. Kept a minute per project and instance, since every card of a project asks.
 */
export function projectEstimate(project: string, now: number = Date.now()): Promise<number | null> {
  const cache = (globalThis.__relayCloudEstimates ??= new Map());
  const hit = cache.get(project);
  if (hit && now - hit.at < ESTIMATE_TTL_MS) return hit.read;
  const read = getFeed({ project, kind: "step.usage", lane: CLOUD_LANE, limit: ESTIMATE_ROWS }).then(
    (rows) => estimateUsd(rows.filter((r) => r.payload.kind === "run").map((r) => r.cost_equiv)),
    () => {
      if (cache.get(project)?.read === read) cache.delete(project);
      return null;
    },
  );
  cache.set(project, { at: now, read });
  return read;
}

/** Where an approved run stands, from the grant and the site's marks in the thread; undefined when nothing is approved for the text as it stands. */
export function approvedView(thread: ThreadView, trusted: readonly string[], now: number): CloudApprovedView | undefined {
  const grant = cloudGrantOf(thread, trusted);
  if (!grant) return undefined;
  const marks = cloudMarksOf(thread, trusted);
  const decision = cloudStart(marks, grant.id, now);
  if ("start" in decision) {
    const before = marks.findLast((m) => m.kind === "failed" && m.grant === grant.id)?.why;
    return { capUsd: grant.capUsd, status: "pending", ...(before ? { why: before } : {}) };
  }
  return { capUsd: grant.capUsd, status: decision.wait, ...(decision.why ? { why: decision.why } : {}) };
}

export interface CloudViewInput {
  session: board.BoardSession;
  workers: readonly board.WorkerView[];
  now: number;
  /** The task's thread when the page has it (the task page). A card reads it only when the root's label says a run was approved. */
  thread?: ThreadView;
}

/** The view for one task; undefined when there is nothing to show. */
export async function cloudView(task: board.BoardTask, i: CloudViewInput): Promise<CloudView | undefined> {
  if (task.state !== "queued") return undefined;
  const config = cloudConfig();
  const thread = i.thread ?? (task.labels[CLOUD_LABEL] === CLOUD_APPROVED ? await i.session.board.thread(task.id).catch(() => undefined) : undefined);
  const read = thread ? approvedView(thread, i.session.from, i.now) : undefined;
  // the pool acts on no grant above the deployment's limit, so one made elsewhere for more is said to go nowhere
  const approved: CloudApprovedView | undefined = read && read.capUsd > config.limits.maxCapUsd ? { capUsd: read.capUsd, status: "gave-up", why: `the approved cap is above this deployment's limit of $${config.limits.maxCapUsd.toFixed(2)} (RELAY_CLOUD_MAX_CAP_USD)` } : read;
  // while a start is due or coming up there is nothing to ask
  if (approved && (approved.status === "pending" || approved.status === "starting")) return { approved };

  const own = subscriptionWorkers(i.workers.filter((w) => !w.retired), i.session.me);
  // the checks that cost nothing first: most queued tasks have a worker, and need no profile read
  const likely = !cloudProblem() && task.project && cloudOffer(task, own, { cloud: "ask" }, i.now, config.limits).offer;
  if (!likely) return approved ? { approved } : undefined;
  const offered = cloudOffer(task, own, (await projectProfile(task.repo)).profile, i.now, config.limits);
  if (!offered.offer) return approved ? { approved } : undefined;
  const estimate = await projectEstimate(task.project!, i.now);
  return { ...(approved ? { approved } : {}), offer: { waitedMs: offered.waitedMs, estimateUsd: estimate, capUsd: defaultCap(estimate, config.limits.maxCapUsd), maxCapUsd: config.limits.maxCapUsd } };
}

/** The views of a board's cards, by task ID: only queued tasks can have one. */
export async function cloudViews(tasks: readonly board.BoardTask[], i: Omit<CloudViewInput, "thread">): Promise<Map<string, CloudView>> {
  const queued = tasks.filter((t) => t.state === "queued");
  const views = await Promise.all(queued.map((t) => cloudView(t, i).catch(() => undefined)));
  return new Map(queued.flatMap((t, n) => (views[n] ? [[t.id, views[n]] as const] : [])));
}
