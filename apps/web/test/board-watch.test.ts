/**
 * The deployment's watchers (lib/board-watch.ts) on an in-memory board that runs them itself, with an in-memory
 * database behind `getDb()`: a task's turns, its run and its model calls reach relay's feed, and a new task gets its
 * brief in its thread.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { board as openBoard } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { board, repo, type Db } from "@relay/core";
import { briefNewTask, siteWatchers, syncDue } from "../lib/board-watch.ts";
import { getDb } from "../lib/db.ts";

const REPO = "acme/demo";
const env = { data: process.env.RELAY_DATA, file: process.env.RELAY_PGLITE_FILE, url: process.env.DATABASE_URL };
let db: Db;
let session: board.BoardSession;

beforeAll(async () => {
  process.env.RELAY_DATA = "db";
  process.env.RELAY_PGLITE_FILE = ":memory:";
  delete process.env.DATABASE_URL;
  globalThis.__relayDb = undefined;
  db = await getDb();
  await repo.upsertProject(db, { slug: "demo", repo: REPO });
  await repo.setProjectSummary(db, "demo", "A small site. Greetings are in English.", 12);
  // the handle a deployment has: the board with the site's watchers on it
  const b = openBoard({ backend: local({ memory: true }), watch: siteWatchers(() => Promise.resolve(session)) });
  await board.ensureSchemas(b);
  session = await board.connectBoard(b, { from: ["board:client:relay-mini-claude"] });
});
afterAll(async () => {
  await db.close();
  globalThis.__relayDb = undefined;
  for (const [k, v] of [["RELAY_DATA", env.data], ["RELAY_PGLITE_FILE", env.file], ["DATABASE_URL", env.url]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Wait for what a watcher does after a write: it runs in the board's own time. */
async function eventually<T>(read: () => Promise<T>, ready: (v: T) => boolean): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await read();
    if (ready(v) || i > 100) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
}

const usage: board.UsageBlock = { kind: "run", lane: "claude", tool: "claude", model: "anthropic/claude-sonnet-5", subscription: "max", billing: "subscription", tokens_in: 1200, tokens_out: 300, cache_read: 50, cache_write: 0, cost_equiv: 0.08, duration_ms: 23_000, worker: "mini", outcome: "review" };

describe("the watchers", () => {
  it("are two tails of every project's queue", () => {
    const w = siteWatchers(() => Promise.resolve(session));
    expect(Object.fromEntries(Object.entries(w).map(([id, x]) => [id, x.tail]))).toEqual({ ledger: "work/", [board.BRIEF_PROFILE]: "work/" });
  });

  it("write a task's turns, its run and its model calls to the feed, and post the brief in its thread", async () => {
    const t = await board.openTask(session.board.as(board.actorProfile("human:kyle")), { project: "demo", repo: REPO, title: "Add a greeting", lane: "claude" });
    const worker = session.board.as("relay-mini-claude");
    const claim = await worker.tasks.claim(t.id);
    const pr = { repo: REPO, number: 7, url: `https://github.com/${REPO}/pull/7` };
    await worker.reply(t.id, { text: [board.runText({ outcome: "review", lane: "claude", worker: "mini", branch: board.branchFor("claude", t.id), pr }), board.usageText(usage)].join("\n\n"), labels: { relay: "usage" }, noSync: true });
    await claim.block(pr.url, { kind: board.HOLD.review });

    const kinds = ["run.finished", "run.started", "step.usage", "task.created"];
    const rows = await eventually(
      () => repo.listEvents(db, { project: "demo", limit: 50 }),
      (r) => kinds.every((k) => r.some((e) => e.kind === k)),
    );
    expect([...new Set(rows.map((e) => e.kind))].sort()).toEqual(kinds);
    expect(rows.find((e) => e.kind === "task.created")).toMatchObject({ actor: "human:kyle", summary: "Add a greeting", lane: "claude", payload: { task: t.id } });
    expect(rows.find((e) => e.kind === "step.usage")).toMatchObject({ actor: "runner:mini", subscription: "max", cost_equiv: 0.08, tokens_in: 1200, payload: { task: t.id, kind: "run" } });
    expect(rows.find((e) => e.kind === "run.finished")).toMatchObject({ repo: REPO, pr: 7, url: pr.url });

    // the brief watcher answered the new task once, as its own profile, with relay's memory for the project
    const briefs = await eventually(
      async () => (await session.board.thread(t.id)).replies.filter((m) => m.labels?.relay === board.RELAY_MESSAGE.brief),
      (r) => r.length > 0,
    );
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.attachments.map((a) => a.name)).toEqual(["brief.md"]);
    const text = await (await session.board.download(briefs[0]!.attachments[0]!.id)).text();
    expect(text).toMatch(/Greetings are in English/);

    // nothing new on the board: a sync writes nothing, and the rows are there once
    expect(await board.syncLedger(db, session)).toMatchObject({ written: [], caught_up: true });
    expect((await repo.listEvents(db, { project: "demo", kind: "step.usage", limit: 50 })).length).toBe(1);
  });

  it("post no brief for a step's own task or for another event, and one however often they are woken", async () => {
    // a board nothing watches, so the only brief is the one this test asks for
    const quiet = await board.memoryBoard();
    const eventsOf = async (id: string) => (await quiet.poll({ channel: board.WORK_SUBTREE, last: 100 })).events.filter((e) => e.message?.id === id || e.message?.re === id);
    const as = quiet.as(board.BRIEF_PROFILE);
    const work = await board.openTask(quiet, { project: "demo", repo: REPO, title: "Add a farewell", lane: "claude" });
    const step = await board.openTask(quiet, { project: "demo", repo: REPO, title: "Eval: Add a farewell", lane: "claude", step: "eval", evaluates: work.id });
    await quiet.reply(work.id, { text: "A note." });

    expect(await briefNewTask(db, as, (await eventsOf(step.id)).find((e) => e.type === "task.created")!)).toBe(false);
    const events = await eventsOf(work.id);
    expect(await briefNewTask(db, as, events.find((e) => e.type === "message.posted" && e.message?.re === work.id)!)).toBe(false);
    const created = events.find((e) => e.type === "task.created")!;
    expect(await briefNewTask(db, as, created)).toBe(true);
    // the same author posting it again changes nothing
    expect(await briefNewTask(db, as, created)).toBe(true);
    expect((await quiet.thread(work.id)).replies.filter((m) => m.labels?.relay === board.RELAY_MESSAGE.brief)).toHaveLength(1);
  });
});

describe("the page-load sync", () => {
  it("is due once per 15 seconds per instance", () => {
    globalThis.__relayLedgerSyncAt = undefined;
    expect(syncDue(1_000_000)).toBe(true);
    expect(syncDue(1_010_000)).toBe(false);
    expect(syncDue(1_015_000)).toBe(true);
  });
});
