/**
 * What a hosted relay does on the board (board/site.ts), on an in-memory board and an in-memory database: the ledger
 * that copies the queues' events into the feed, the brief in a task's thread, and a merge on GitHub settling a task.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectBoard } from "../src/board/client.ts";
import { branchFor, HOLD } from "../src/board/mapping.ts";
import { runText, usageText, type UsageBlock } from "../src/board/schemas.ts";
import { actorProfile, feedActor, LEDGER_CURSOR, postBrief, settleMerged, syncLedger } from "../src/board/site.ts";
import { closeTask, getTask, openTask } from "../src/board/tasks.ts";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { listEvents } from "../src/db/events.ts";
import { getSetting } from "../src/db/settings.ts";
import { threadBrief } from "../src/work/job.ts";
import { relayBoard } from "./helpers/board.ts";

const REPO = "acme/demo";
const usage = (over: Partial<UsageBlock> = {}): UsageBlock => ({ kind: "run", lane: "claude", tool: "claude", model: "anthropic/claude-sonnet-5", subscription: "max", billing: "subscription", tokens_in: 1200, tokens_out: 300, cache_read: 50, cache_write: 0, cost_equiv: 0.08, duration_ms: 23_000, worker: "mini", ...over });

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
});
afterAll(() => db.close());

describe("the profile the site writes as", () => {
  it("is the actor's own name in the board's alphabet, and stays within 32 characters", () => {
    expect(actorProfile("human:kyleroche")).toBe("human-kyleroche");
    expect(actorProfile("bot:Grok Bot")).toBe("bot-grok-bot");
    expect(actorProfile("42")).toBe("x-42");
    const long = actorProfile("bot:a-very-long-integration-name-that-goes-on");
    expect(long).toMatch(/^bot-a-very-long-integration-[0-9a-f]{4}$/);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(actorProfile("bot:a-very-long-integration-name-that-goes-off")).not.toBe(long);
  });
  it("reads back as the feed's actor", () => {
    const by = (profile: string | null, principal = "vercel:project:prj_1:production") => ({ actor: profile ? `${principal}+${profile}` : principal, principal, profile });
    expect(feedActor(by("human-kyleroche"))).toBe("human:kyleroche");
    expect(feedActor(by("bot-grok-bot"))).toBe("bot:grok-bot");
    expect(feedActor(by(actorProfile("bot:oauth:grok-bot")))).toBe("bot:oauth:grok-bot");
    expect(feedActor(by("relay-mini-claude"))).toBe("runner:mini-claude");
    expect(feedActor(by(null, "vercel:user:u_1"), "kyleroche")).toBe("human:kyleroche");
    expect(feedActor(by(null), "relay")).toBe("agent:relay");
  });
});

describe("the ledger", () => {
  it("copies a task's turns, its runs and its model calls into the feed once, from a cursor it keeps", async () => {
    const board = await relayBoard();
    const s = await connectBoard(board, { from: ["board:client:relay-mini-claude"] });
    const t = await openTask(board, { project: "demo", repo: REPO, title: "Add a greeting", lane: "claude", model: "sonnet" });
    const worker = board.as("relay-mini-claude");
    const claim = await worker.tasks.claim(t.id);
    const pr = { repo: REPO, number: 7, url: `https://github.com/${REPO}/pull/7` };
    await worker.reply(t.id, { text: [runText({ outcome: "review", lane: "claude", worker: "mini", branch: branchFor("claude", t.id), pr }), usageText(usage({ kind: "gate", lane: "gate", cost_equiv: 0.01 })), usageText(usage({ outcome: "review" }))].join("\n\n"), labels: { relay: "usage" }, noSync: true });
    // a stranger's usage row is not relay's
    await board.as("stranger").reply(t.id, { text: usageText(usage({ cost_equiv: 999 })), noSync: true });
    await claim.block(pr.url, { kind: HOLD.review });

    const first = await syncLedger(db, s);
    expect(first).toMatchObject({ caught_up: true });
    expect(first.written).toHaveLength(5);
    expect(await getSetting(db, LEDGER_CURSOR)).toBe(first.cursor);
    const rows = (await listEvents(db, { project: "demo", limit: 50 })).reverse();
    expect(rows.map((e) => e.kind)).toEqual(["task.created", "run.started", "step.usage", "step.usage", "run.finished"]);
    expect(rows[0]).toMatchObject({ summary: "Add a greeting", lane: "claude", payload: { task: t.id, model: "sonnet" } });
    expect(rows[1]!.actor).toBe("runner:mini-claude");
    expect(rows[4]).toMatchObject({ actor: "runner:mini", repo: REPO, pr: 7, url: pr.url, payload: { task: t.id, conclusion: "review" } });
    expect(rows.filter((e) => e.kind === "step.usage").map((e) => [e.lane, e.subscription, e.cost_equiv, e.payload.kind])).toEqual([["gate", "max", 0.01, "gate"], ["claude", "max", 0.08, "run"]]);

    // nothing new: nothing written, and reading the same events again writes nothing either
    expect(await syncLedger(db, s)).toMatchObject({ events: 0, written: [], caught_up: true });

    await closeTask(board, undefined, t.id, { reason: "not needed" });
    const later = await syncLedger(db, s);
    expect(later.written.map((e) => e.kind)).toEqual(["task.closed"]);
    expect((await listEvents(db, { project: "demo", limit: 1 }))[0]).toMatchObject({ kind: "task.closed", summary: "Add a greeting: not needed" });
  });
});

describe("the brief", () => {
  it("is posted in the thread once, where a worker that trusts the poster finds it", async () => {
    const board = await relayBoard();
    const me = (await board.me()).principal;
    const t = await openTask(board, { project: "demo", repo: REPO, title: "Add a greeting", lane: "claude" });
    const site = board.as("brief");
    expect(await postBrief(site, t.id, "## Decisions\n\n- greet in English")).toBe(true);
    expect(await postBrief(site, t.id, "another")).toBe(false);
    const { thread } = await getTask(board, t.id);
    expect(await threadBrief(board, thread, ["board:client:brief"])).toBe("## Decisions\n\n- greet in English");
    expect(await threadBrief(board, thread, [me])).toBeUndefined();
  });
});

describe("a merge on GitHub", () => {
  it("completes the task in review that waits on that pull request, and no other", async () => {
    const board = await relayBoard();
    const t = await openTask(board, { project: "demo", repo: REPO, title: "Add a greeting", lane: "claude" });
    const url = `https://github.com/${REPO}/pull/7`;
    await (await board.as("relay-mini-claude").tasks.claim(t.id)).block(url, { kind: HOLD.review });
    expect(await settleMerged(board, { url, head_ref: "feature/someone-elses" })).toBeUndefined();
    expect(await settleMerged(board, { url: `https://github.com/${REPO}/pull/8`, head_ref: branchFor("claude", t.id) })).toBeUndefined();
    const done = await settleMerged(board, { url, head_ref: branchFor("claude", t.id), merge_sha: "0123456789abcdef" });
    expect(done).toMatchObject({ id: t.id, state: "done", result: `merged ${REPO}#7 on GitHub in 0123456` });
  });
});
