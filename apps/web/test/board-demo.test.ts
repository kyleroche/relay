/**
 * The demo board (lib/board-demo.ts) and what the pages read from it (lib/board-read.ts) in mock mode: every state
 * and every column has a card, the fleet has each kind of worker, and the plan meters are the demo workers' readings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { board } from "@relay/core";
import { siteBoard } from "../lib/board.ts";
import { fleet, openTasks, planMeters, recentTasks, waitingOnYou, workerOfClaim } from "../lib/board-read.ts";
import { projectProfile } from "../lib/profile.ts";
import { COLUMNS, columnOf, decisionsFor, evalWait, reviewKind } from "../lib/tasks.ts";

const saved = { data: process.env.RELAY_DATA, url: process.env.DATABASE_URL };

beforeAll(() => {
  process.env.RELAY_DATA = "mock";
  delete process.env.DATABASE_URL;
  globalThis.__relayBoard = undefined;
  globalThis.__relayWorkers = undefined;
});
afterAll(() => {
  if (saved.data === undefined) delete process.env.RELAY_DATA;
  else process.env.RELAY_DATA = saved.data;
  if (saved.url !== undefined) process.env.DATABASE_URL = saved.url;
  globalThis.__relayBoard = undefined;
  globalThis.__relayWorkers = undefined;
});

describe("the demo board", () => {
  it("has a task in every state and a card in every column, newest first", async () => {
    const open = await openTasks();
    const finished = (await recentTasks({ states: ["done", "closed"] })).tasks;
    const tasks = [...open, ...finished];
    expect(new Set(tasks.map((t) => t.state))).toEqual(new Set(board.RELAY_STATES));
    for (const c of COLUMNS) expect(tasks.filter((t) => columnOf(t) === c.key).length, c.key).toBeGreaterThan(0);
    expect(open.map((t) => t.created_at)).toEqual([...open.map((t) => t.created_at)].sort().reverse());
    expect(open.every((t) => t.state !== "done" && t.state !== "closed")).toBe(true);
    expect(finished.every((t) => t.state === "done" || t.state === "closed")).toBe(true);
    // one project's queue is that project's tasks only, and a name that is no slug has none
    const relay = [...(await openTasks("relay")), ...(await recentTasks({ project: "relay" })).tasks];
    expect(relay.length).toBeGreaterThan(0);
    expect(relay.every((t) => t.project === "relay")).toBe(true);
    expect(await openTasks("Not A Slug")).toEqual([]);
    expect((await recentTasks({ project: "Not A Slug" })).tasks).toEqual([]);
    expect(await openTasks("no-queue-yet")).toEqual([]);
  });

  it("holds what each state is for: a pull request in review, outputs, a plan, an eval, the gate, a dependency", async () => {
    const { board: b } = await siteBoard();
    const tasks = [...(await openTasks()), ...(await recentTasks({ limit: 200 })).tasks];
    const review = tasks.filter((t) => t.state === "review");
    expect(review.find((t) => t.pr)?.pr).toMatchObject({ repo: "acme/ledger-api", number: 88, url: "https://github.com/acme/ledger-api/pull/88" });
    // every task is in the list twice (open, and by latest activity), so each kind is counted by its tasks
    expect([...new Map(review.map((t) => [t.id, reviewKind(t)])).values()].sort()).toEqual(["outputs", "plan", "pr"]);
    const outputs = review.find((t) => reviewKind(t) === "outputs")!;
    const detail = await board.getTask(b, outputs.id);
    expect(detail.thread.replies.flatMap((m) => board.blocksOf<board.AssetBlock>(m, board.ASSET_SCHEMA)).map((a) => a.mime)).toEqual(["video/mp4", "image/png"]);
    expect(detail.usage.map((u) => u.kind)).toEqual(["media"]);

    const judged = tasks.find((t) => t.state === "blocked")!;
    const waits = evalWait(judged)!;
    expect(columnOf(judged)).toBe("review");
    expect(tasks.find((t) => t.id === waits.task)).toMatchObject({ step: "eval", evaluates: judged.id, state: "running" });

    expect(tasks.find((t) => t.state === "held")?.hold).toMatchObject({ kind: board.HOLD.gate });
    const waiting = tasks.find((t) => t.state === "waiting")!;
    expect(tasks.find((t) => t.id === waiting.needs[0])?.state).toBe("queued");
    expect(tasks.find((t) => t.state === "done")?.result).toMatch(/^merged acme\/relay#212/);
    expect(tasks.find((t) => t.state === "closed")?.reason).toMatch(/pricing/);
    expect(tasks.find((t) => t.state === "failed")?.reason).toMatch(/exited 1/);
    expect(await waitingOnYou()).toEqual({ review: 3, held: 1 });

    // the plan in review is the file on the reply its hold names, with that file's digest: what an approval opens
    const planned = review.find((t) => reviewKind(t) === "plan")!;
    expect(planned).toMatchObject({ project: "atlas-site", step: "plan", pr: null });
    const at = board.parsePlanHold(planned.hold?.reason)!;
    const proposal = (await board.getTask(b, planned.id)).thread.replies.find((m) => m.id === at.message)!;
    expect(proposal.attachments.map((f) => f.name)).toEqual([board.PLAN_FILE]);
    expect(proposal.text).toMatch(/^Proposed plan: 2 tasks\. Approving it opens them/);

    // a person's note and relay's own lines are both in a thread, and only the note is a note
    const withNote = await board.getTask(b, review.find((t) => t.pr)!.id);
    expect(withNote.notes.map((n) => n.text)).toEqual(["Looks right. Does the migration lock the table on a large ledger?"]);
    expect(withNote.usage.map((u) => u.kind)).toEqual(["gate", "run"]);
  });

  it("has a fleet with what each worker runs, and plan meters marked as demo numbers", async () => {
    const workers = await fleet();
    expect(Object.fromEntries(workers.map((w) => [w.name, w.retired ? "retired" : w.state]))).toEqual({ studio: "online", loft: "idle", field: "offline", "studio-host": "retired" });
    const studio = workers.find((w) => w.name === "studio")!;
    expect(studio.current.map((t) => t.lane).sort()).toEqual(["claude"]);
    expect(workers.find((w) => w.name === "loft")!.current.map((t) => t.step)).toEqual(["eval"]);
    expect(board.servedLanes(workers)).toEqual(["claude", "codex", "grok", "nodes"]);
    const running = (await openTasks()).filter((t) => t.state === "running");
    expect(running.map((t) => workerOfClaim(workers, t.claim)?.name).sort()).toEqual(["loft", "studio"]);

    const meters = await planMeters();
    expect(meters.slice(0, 2).map((m) => [m.id, m.source, m.percentUsed, m.worker])).toEqual([["max-5h", "demo", 38, "studio"], ["max-week", "demo", 61, "studio"]]);
  });
});

describe("the demo's profiles", () => {
  it("give one project capability sets to grant, and the others none", async () => {
    const atlas = await projectProfile("acme/atlas-site");
    expect(Object.keys(atlas.profile!.sets)).toEqual(["preview", "cms"]);
    expect(atlas.profile!.sets.cms).toEqual({ env: ["CMS_READ_TOKEN"], hosts: ["cdn.example-cms.com", "api.example-cms.com"] });
    expect(atlas.profile).toMatchObject({ cloud: "ask", problems: [] });
    expect(atlas.why).toBeUndefined();
    const relay = await projectProfile("acme/relay");
    expect(relay.profile).toMatchObject({ sets: {}, cloud: "ask" });
    expect(relay.why).toMatch(/no \.relay\/project\.json/);
    expect((await projectProfile(null)).profile).toBeUndefined();
  });
});

describe("what a state allows", () => {
  it("follows core's task functions", () => {
    expect(decisionsFor("review")).toEqual({ review: true, release: false, requeue: true, close: true });
    expect(decisionsFor("held")).toEqual({ review: false, release: true, requeue: true, close: true });
    expect(decisionsFor("running")).toEqual({ review: false, release: false, requeue: false, close: true });
    for (const s of ["done", "closed"] as const) expect(decisionsFor(s)).toEqual({ review: false, release: false, requeue: false, close: false });
    for (const s of ["waiting", "queued", "blocked", "failed"] as const) expect(decisionsFor(s)).toMatchObject({ review: false, requeue: true, close: true });
  });
});
