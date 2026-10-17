/**
 * The demo site's flow: two projects, three workers, six tasks spread across the stations, and a scripted loop that
 * moves exactly one task every 8 seconds so the map is never still. Everything is a pure function of `Date.now()`:
 * two browsers (or two server instances) see the same scene, and a reload lands mid-motion rather than at a reset.
 *
 * The loop is LOOP steps long. Each step names the one task that moves and where to. A task whose script ends at
 * Merged is drawn there for one step and then leaves the snapshot (the client fades it off the right edge). When the
 * loop wraps, the issue numbers advance by a stride, so the wrapped tasks read as a fresh batch sliding in from the
 * project stops instead of the same pills jumping back.
 */
import type { FlowSnapshot, FlowTask, FlowWorker, Station } from "./flow.ts";
import type { Worker } from "./types.ts";

export const FLOW_STEP_MS = 8_000;
const LOOP = 20;
const ISSUE_STRIDE = 12;

const PROJECTS = [
  { slug: "relay", repo: "acme/relay" },
  { slug: "atlas-site", repo: "acme/atlas-site" },
] as const;

interface Scripted {
  project: (typeof PROJECTS)[number]["slug"];
  issue: number;
  title: string;
  lane: "claude" | "codex" | "grok";
  pr: number;
  /** step -> station. Negative steps are "already there when the loop starts" and only set `since`. */
  script: Array<[step: number, station: Station, worker?: string]>;
  error?: string;
  cost?: number;
}

const TASKS: Scripted[] = [
  {
    project: "relay",
    issue: 231,
    title: "Add dark mode to the asset viewer",
    lane: "claude",
    pr: 240,
    cost: 0.84,
    script: [[-3, "Preview"], [1, "Review"], [7, "Merged"]],
  },
  {
    project: "relay",
    issue: 228,
    title: "Paginate the feed API with a cursor",
    lane: "codex",
    pr: 241,
    cost: 0.31,
    script: [[-2, "Running", "studio"], [5, "PR"], [10, "Preview"], [16, "Review"]],
  },
  {
    project: "atlas-site",
    issue: 57,
    title: "Fix the hero image aspect ratio on phones",
    lane: "grok",
    pr: 63,
    cost: 0.12,
    script: [[-6, "Queue"], [6, "Claimed", "studio"], [8, "Running", "studio"], [14, "PR"], [19, "Preview"]],
  },
  {
    project: "atlas-site",
    issue: 61,
    title: "Write the pricing page copy from the brief",
    lane: "claude",
    pr: 64,
    cost: 0.57,
    script: [[-1, "PR"], [4, "Preview"], [11, "Review"], [15, "Merged"]],
  },
  {
    project: "relay",
    issue: 234,
    title: "Retry webhook deliveries with backoff",
    lane: "codex",
    pr: 243,
    cost: 0.22,
    script: [[3, "Queue"], [12, "Claimed", "loft"], [13, "Running", "loft"]],
  },
  {
    project: "atlas-site",
    issue: 49,
    title: "Upgrade to Next 16 and the new proxy file",
    lane: "claude",
    pr: 60,
    cost: 1.08,
    error: "lane exited 1: pnpm typecheck failed (3 errors in app/page.tsx)",
    script: [[-4, "Running", "loft"], [2, "Failed"], [9, "Queue"], [17, "Claimed", "studio"], [18, "Running", "studio"]],
  },
];

const STATE_OF: Record<Station, FlowTask["state"]> = {
  Queue: "queued",
  Claimed: "claimed",
  Running: "running",
  PR: "review",
  Preview: "review",
  Review: "review",
  Merged: "done",
  Failed: "failed",
};

/** The scene at `now`: which tasks are drawn, where, since when, and who is on them. */
export function flowScene(now: number, workers: Worker[]): FlowSnapshot {
  const cycle = Math.floor(now / FLOW_STEP_MS);
  const loops = Math.floor(cycle / LOOP);
  const step = cycle - loops * LOOP;
  const loopStart = loops * LOOP * FLOW_STEP_MS;
  // the batch number only has to differ between neighbouring loops; keep the issue numbers plausible
  const loop = loops % 40;
  const at = (s: number) => new Date(loopStart + s * FLOW_STEP_MS).toISOString();

  const tasks: FlowTask[] = [];
  const onTask = new Map<string, string>(); // worker -> task id
  for (const t of TASKS) {
    const reached = t.script.filter(([s]) => s <= step);
    const current = reached.at(-1);
    if (!current) continue; // not yet opened this loop
    const [enteredAt, station, worker] = current;
    if (station === "Merged" && step > enteredAt) continue; // drawn at Merged for one step, then gone
    const project = PROJECTS.find((p) => p.slug === t.project)!;
    const issue = t.issue + loop * ISSUE_STRIDE;
    const id = `${project.repo}#${issue}`;
    const pr = t.pr + loop * ISSUE_STRIDE;
    const hasPr = station === "PR" || station === "Preview" || station === "Review" || station === "Merged";
    const previewReady = station === "Preview" || station === "Review" || station === "Merged";
    const runner = worker ?? (station === "Failed" ? (t.script.find(([, st, w]) => st === "Running" && w)?.[2] ?? null) : null);
    if (worker && (station === "Claimed" || station === "Running")) onTask.set(worker, id);
    tasks.push({
      id,
      project: t.project,
      repo: project.repo,
      issue,
      title: t.title,
      lane: t.lane,
      state: STATE_OF[station],
      station,
      since: at(enteredAt),
      pr: hasPr ? pr : null,
      pr_url: hasPr ? `https://github.com/${project.repo}/pull/${pr}` : null,
      preview_state: previewReady ? "ready" : hasPr ? "building" : "none",
      preview_url: previewReady ? `https://${project.slug}-git-relay-${t.lane}-${issue}-acme.vercel.app` : null,
      runner: runner ? `runner:${runner}` : null,
      ...(station === "Failed" && t.error ? { error: t.error } : {}),
      ...(hasPr || station === "Failed" ? { cost: t.cost ?? null } : {}),
    });
  }

  const inMotion = new Set(tasks.filter((t) => t.state !== "done").map((t) => t.project));
  const flowWorkers: FlowWorker[] = workers.map((w) => {
    const current = onTask.get(w.name);
    const state: FlowWorker["state"] = w.status === "offline" ? "offline" : current || w.name === "studio" ? "online" : "idle";
    return {
      name: w.name,
      lanes: w.lanes,
      state,
      current: current ? { task_id: current } : null,
      last_seen: state === "online" ? new Date(now - 20_000).toISOString() : w.lastSeen,
    };
  });

  return {
    ts: new Date(now).toISOString(),
    projects: PROJECTS.filter((p) => inMotion.has(p.slug)).map((p) => ({ slug: p.slug, repo: p.repo })),
    workers: flowWorkers,
    tasks,
  };
}
