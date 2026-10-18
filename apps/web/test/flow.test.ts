import { describe, expect, it } from "vitest";
import { deriveStation, failureLine, fmtDwell, laneOf, stationOf, stationSince, type StationEvent, type StationInput } from "../lib/flow.ts";
import { flowScene, FLOW_STEP_MS } from "../lib/flow-mock.ts";
import type { Worker } from "../lib/types.ts";

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const ev = (kind: string, minutes: number, extra: Partial<StationEvent> = {}): StationEvent => ({ kind, ts: at(minutes), ...extra });

const base = (state: StationInput["state"], extra: Partial<StationInput> = {}): StationInput => ({
  state,
  preview_state: "none",
  preview_url: null,
  review: { decided: null, at: null },
  merged_at: null,
  updated_at: at(50),
  created_at: at(0),
  ...extra,
});

describe("stationOf", () => {
  it("maps the plain states one to one", () => {
    expect(stationOf(base("queued"))).toBe("Queue");
    expect(stationOf(base("claimed"))).toBe("Claimed");
    expect(stationOf(base("running"))).toBe("Running");
    expect(stationOf(base("done"))).toBe("Merged");
    expect(stationOf(base("failed"))).toBe("Failed");
    // the injection gate holds a task at the first stop; the flow task carries `held: true` for the flag
    expect(stationOf(base("held"))).toBe("Queue");
  });

  it("splits review by the preview: PR until one is ready, then Preview", () => {
    const events = [ev("run.started", 10), ev("pr.opened", 20)];
    expect(stationOf(base("review", { preview_state: "none" }), events)).toBe("PR");
    expect(stationOf(base("review", { preview_state: "building" }), events)).toBe("PR");
    expect(stationOf(base("review", { preview_state: "failed" }), events)).toBe("PR");
    expect(stationOf(base("review", { preview_state: "ready" }), [...events, ev("preview.ready", 25)])).toBe("Preview");
  });

  it("moves to Review once someone engaged after the last push, whatever the preview says", () => {
    const pushed = [ev("pr.opened", 20), ev("preview.ready", 25)];
    expect(stationOf(base("review", { preview_state: "ready" }), [...pushed, ev("pr.review", 30)])).toBe("Review");
    expect(stationOf(base("review", { preview_state: "none" }), [...pushed, ev("task.merge_failed", 31)])).toBe("Review");
    // a review on an older PR does not count once a new run pushed again
    expect(stationOf(base("review", { preview_state: "ready" }), [ev("pr.opened", 5), ev("pr.review", 8), ev("run.finished", 20, { payload: { conclusion: "success" } })])).toBe("Preview");
  });
});

describe("stationSince", () => {
  it("is the moment the task reached the station, not the task's age", () => {
    const events = [ev("issue.opened", 0), ev("issue.labeled", 1), ev("run.started", 10), ev("run.finished", 20, { payload: { conclusion: "success" } }), ev("pr.opened", 21), ev("preview.ready", 25, { url: "https://p.example" }), ev("pr.review", 30)];
    expect(stationSince(base("review"), "PR", events)).toBe(at(21));
    expect(stationSince(base("review", { preview_url: "https://p.example" }), "Preview", events)).toBe(at(25));
    expect(stationSince(base("review"), "Review", events)).toBe(at(30));
    expect(stationSince(base("running"), "Running", events)).toBe(at(10));
    expect(stationSince(base("queued"), "Queue", events)).toBe(at(1));
  });

  it("takes the latest re-entry into Queue: a requeue, a send-back or a closed PR", () => {
    expect(stationSince(base("queued"), "Queue", [ev("issue.labeled", 1), ev("run.started", 10), ev("task.changes_requested", 40)])).toBe(at(40));
    expect(stationSince(base("queued"), "Queue", [ev("issue.labeled", 1), ev("task.requeued", 45)])).toBe(at(45));
    expect(stationSince(base("queued"), "Queue", [ev("issue.labeled", 1), ev("pr.closed", 33)])).toBe(at(33));
    // a hold and its release are re-entries too: the dwell timer counts from the gate's decision
    expect(stationSince(base("held"), "Queue", [ev("issue.labeled", 1), ev("task.held", 2)])).toBe(at(2));
    expect(stationSince(base("queued"), "Queue", [ev("issue.labeled", 1), ev("task.held", 2), ev("task.released", 50)])).toBe(at(50));
  });

  it("uses the live claim for Claimed (the feed has no row for it) and falls back to updated_at", () => {
    expect(stationSince(base("claimed"), "Claimed", [ev("issue.labeled", 1)], { claimedAt: at(12) })).toBe(at(12));
    expect(stationSince(base("claimed"), "Claimed", [ev("issue.labeled", 1)])).toBe(at(50));
  });

  it("dates Merged from merged_at or the merge event, Failed from the failing run", () => {
    expect(stationSince(base("done", { merged_at: at(60) }), "Merged", [])).toBe(at(60));
    expect(stationSince(base("done"), "Merged", [ev("task.approved", 58, { payload: { merged: true } })])).toBe(at(58));
    expect(stationSince(base("done"), "Merged", [ev("issue.closed", 59)])).toBe(at(59));
    expect(stationSince(base("failed"), "Failed", [ev("run.started", 10), ev("run.failed", 15)])).toBe(at(15));
    expect(stationSince(base("failed"), "Failed", [ev("run.started", 10), ev("run.finished", 16, { payload: { conclusion: "timed_out" } })])).toBe(at(16));
  });

  it("falls back to now when a task has nothing at all", () => {
    const now = T0 + 99 * 60_000;
    expect(stationSince({ state: "queued", preview_state: "none" }, "Queue", [], { now })).toBe(new Date(now).toISOString());
  });
});

describe("deriveStation", () => {
  it("returns the pair", () => {
    const events = [ev("issue.labeled", 1), ev("run.started", 10), ev("run.failed", 15, { payload: { error: "pnpm typecheck failed" } })];
    expect(deriveStation(base("failed"), events)).toEqual({ station: "Failed", since: at(15) });
    expect(failureLine(events)).toBe("pnpm typecheck failed");
    expect(failureLine([{ ...ev("run.finished", 16, { payload: { conclusion: "failure" } }), summary: "no changes" }])).toBe("no changes");
    expect(failureLine([ev("run.started", 10)])).toBeUndefined();
  });
});

describe("helpers", () => {
  it("names the lane line, with cloud for anything else", () => {
    expect(laneOf("claude")).toBe("claude");
    expect(laneOf("grok")).toBe("grok");
    expect(laneOf("claude-cloud")).toBe("cloud");
    expect(laneOf(null)).toBe("cloud");
  });

  it("formats dwell times compactly", () => {
    expect(fmtDwell(at(0), T0 + 12_000)).toBe("12s");
    expect(fmtDwell(at(0), T0 + 3 * 60_000)).toBe("3m");
    expect(fmtDwell(at(0), T0 + 72 * 60_000)).toBe("1h 12m");
    expect(fmtDwell(at(0), T0 + 27 * 3_600_000)).toBe("1d 3h");
    expect(fmtDwell(at(5), T0)).toBe("0s");
  });
});

describe("flowScene (mock)", () => {
  const workers: Worker[] = [
    { name: "studio", host: "studio.local", labels: [], lastSeen: at(0), status: "online", retired: false, lanes: ["claude", "codex", "grok"], version: "", runsToday: 0, pollMs: null, current: null },
    { name: "loft", host: "loft.local", labels: [], lastSeen: at(0), status: "idle", retired: false, lanes: ["claude", "codex"], version: "", runsToday: 0, pollMs: null, current: null },
    { name: "field", host: "field", labels: [], lastSeen: at(0), status: "offline", retired: false, lanes: ["claude"], version: "", runsToday: 0, pollMs: null, current: null },
  ];
  const loopStart = Math.floor(T0 / (FLOW_STEP_MS * 20)) * FLOW_STEP_MS * 20;

  it("is deterministic in the clock and moves one task per step", () => {
    const a = flowScene(loopStart + 1000, workers);
    const b = flowScene(loopStart + 7000, workers);
    expect(a.tasks.map((t) => [t.id, t.station])).toEqual(b.tasks.map((t) => [t.id, t.station]));
    const c = flowScene(loopStart + FLOW_STEP_MS + 1000, workers);
    const moved = c.tasks.filter((t) => a.tasks.find((x) => x.id === t.id)?.station !== t.station);
    expect(moved.length).toBe(1);
  });

  it("spreads the opening scene across the stations and keeps the states consistent", () => {
    const s = flowScene(loopStart + 1000, workers);
    const stations = new Set(s.tasks.map((t) => t.station));
    expect(stations.size).toBeGreaterThanOrEqual(4);
    for (const t of s.tasks) {
      expect(new Date(t.since).getTime()).toBeLessThanOrEqual(loopStart + 1000);
      if (t.station === "Running") expect(t.state).toBe("running");
      if (t.station === "Preview") expect(t.preview_state).toBe("ready");
      if (t.station === "Queue") expect(t.pr).toBeNull();
    }
    expect(s.projects.map((p) => p.slug).sort()).toEqual(["atlas-site", "relay"]);
    const studio = s.workers.find((w) => w.name === "studio")!;
    expect(studio.current?.task_id).toBe(s.tasks.find((t) => t.runner === "runner:studio" && t.station === "Running")?.id);
    expect(s.workers.find((w) => w.name === "field")?.state).toBe("offline");
  });

  it("drops a merged task after one step and gives a failed one its error", () => {
    const steps = Array.from({ length: 20 }, (_, i) => flowScene(loopStart + i * FLOW_STEP_MS + 1000, workers));
    const merged = steps.flatMap((s, i) => s.tasks.filter((t) => t.station === "Merged").map((t) => ({ i, id: t.id })));
    expect(merged.length).toBeGreaterThan(0);
    for (const m of merged) expect(steps[m.i + 1]?.tasks.some((t) => t.id === m.id) ?? false).toBe(false);
    const failed = steps.flatMap((s) => s.tasks.filter((t) => t.station === "Failed"));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toMatch(/typecheck/);
  });
});
