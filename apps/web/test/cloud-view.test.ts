/**
 * What a page shows about a paid sandbox run (lib/cloud/view.ts), on an in-memory board: the offer for a queued task
 * nobody's machine can take, computed from the board with nothing written, and where an approved run stands. The
 * estimate is read from an in-memory database's feed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { board, CLOUD_APPROVED, CLOUD_CAP_NOTE, CLOUD_EXPERIMENTAL_NOTE, CLOUD_LABEL, cloudFailedText, cloudStartKey, cloudStartText, repo, type Db } from "@relay/core";
import { cloudProblem } from "../lib/cloud/config.ts";
import { approvedView, cloudView, cloudViews, projectEstimate } from "../lib/cloud/view.ts";
import { getDb } from "../lib/db.ts";

const MIN = 60_000;
const person: board.Asker = { actor: "human:kyle" };
const env = { data: process.env.RELAY_DATA, file: process.env.RELAY_PGLITE_FILE, url: process.env.DATABASE_URL, key: process.env.RELAY_GATEWAY_TOKEN };

let b: board.Board;
let session: board.BoardSession;

function mode(data: "mock" | "db"): void {
  process.env.RELAY_DATA = data;
  delete process.env.DATABASE_URL;
  globalThis.__relayCloudEstimates = undefined;
  globalThis.__relayProfiles = undefined;
}
beforeEach(async () => {
  mode("mock");
  b = await board.memoryBoard();
  session = await board.connectBoard(b);
});
afterAll(() => {
  for (const [k, v] of [["RELAY_DATA", env.data], ["RELAY_PGLITE_FILE", env.file], ["DATABASE_URL", env.url], ["RELAY_GATEWAY_TOKEN", env.key]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const desk = () => board.deskFor(session, person);
/** A queued task of the demo project that has a profile (lib/mock.ts). */
async function open(over: Partial<board.OpenTaskInput> = {}): Promise<board.BoardTask> {
  return (await board.openFor(desk(), { project: "atlas-site", repo: "acme/atlas-site", title: "Add dark mode", body: "Toggle in the header.", lane: "claude", ...over })).task;
}
const worker = (over: Partial<board.WorkerView>): board.WorkerView => ({ id: "w", by: "kyle", name: "studio", host: "studio.local", lanes: ["claude"], labels: [], version: "0.4.0", last_seen: new Date().toISOString(), state: "online", retired: false, running: 0, meters: [], ...over });
const input = (workers: board.WorkerView[] = [], minutes = 20) => ({ session, workers, now: Date.now() + minutes * MIN });

describe("the offer", () => {
  it("is made for a queued task that has waited and that no worker can take, with a cap to start from", async () => {
    const t = await open();
    expect(await cloudView(t, input())).toEqual({ offer: { waitedMs: expect.any(Number), estimateUsd: null, capUsd: 1, maxCapUsd: 10, capNote: CLOUD_CAP_NOTE, experimental: CLOUD_EXPERIMENTAL_NOTE } });
    expect(await cloudView(t, input([worker({ state: "offline" }), worker({ name: "loft", lanes: ["codex", "nodes"] })]))).toHaveProperty("offer");
    // nothing was written to make it
    expect((await b.thread(t.id)).replies).toEqual([]);
  });

  it("is not made while a worker of the owner's can take the task, or before the task has waited", async () => {
    const t = await open();
    expect(await cloudView(t, input([worker({})]))).toBeUndefined();
    expect(await cloudView(t, input([worker({ state: "idle" })]))).toBeUndefined();
    expect(await cloudView(t, input([], 5))).toBeUndefined();
    expect(await cloudView(await open({ lane: "any", title: "Any lane" }), input([worker({ lanes: ["grok"] })]))).toBeUndefined();
  });

  it("does not count a retired machine, nor a worker the site itself started", async () => {
    const t = await open();
    expect(await cloudView(t, input([worker({ retired: true })]))).toHaveProperty("offer");
    expect(await cloudView(t, input([worker({ name: "cloud-0a1b2c3d", by: session.me.principal })]))).toHaveProperty("offer");
  });

  it("is not made for a task that is not queued, or on a lane a paid run does not serve", async () => {
    const running = await open();
    await b.as("relay-studio-claude").tasks.claim(running.id);
    expect(await cloudView(board.toTask((await b.thread(running.id)).message), input())).toBeUndefined();
    expect(await cloudView(await open({ lane: "codex", title: "On codex" }), input())).toBeUndefined();
  });

  it("is not made on a deployment that is not set up for paid runs", async () => {
    const t = await open();
    mode("db");
    delete process.env.RELAY_GATEWAY_TOKEN;
    expect(cloudProblem()).toMatch(/RELAY_GATEWAY_TOKEN/);
    expect(await cloudView(t, input())).toBeUndefined();
  });

  it("is on the cards that can have one, by task", async () => {
    const waiting = await open();
    const other = await open({ lane: "grok", title: "On grok" });
    const views = await cloudViews([waiting, other], input());
    expect([...views.keys()]).toEqual([waiting.id]);
  });
});

describe("an approved run", () => {
  // as the pool writes its marks: relay's own log, so they are no note a grant would have to cover (`grantDigest`)
  const log = { labels: { [board.LABEL.relay]: board.RELAY_MESSAGE.log }, noSync: true };
  const mark = (id: string, grant: string, n: number) => b.as(board.SITE_PROFILE).reply(id, { text: cloudStartText({ grant, n, sandbox: "relay-cloud-a-b", capUsd: 2, timeoutMs: 30 * MIN, nonce: "0123abcd" }), ...log, id: cloudStartKey(id, grant, n) });
  const grantId = async (id: string) => (await b.thread(id)).replies.find((m) => m.blocks.some((x) => x.schema === "relay-grant"))!.id;

  it("replaces the offer while it is due or coming up", async () => {
    const t = await open();
    await board.grantFor(desk(), t.id, { cloudCapUsd: 2 });
    const thread = await b.thread(t.id);
    expect(await cloudView(t, { ...input(), thread })).toEqual({ approved: { capUsd: 2, status: "pending" } });
    await mark(t.id, await grantId(t.id), 1);
    expect(await cloudView(t, { ...input([], 0), thread: await b.thread(t.id) })).toEqual({ approved: { capUsd: 2, status: "starting" } });
  });

  it("is read from the thread on a card only when the root's label says to look", async () => {
    const t = await open();
    await board.grantFor(desk(), t.id, { cloudCapUsd: 2 });
    expect(await cloudView(t, input())).toHaveProperty("offer");
    await b.label(t.id, { set: { [CLOUD_LABEL]: CLOUD_APPROVED } });
    expect(await cloudView(board.toTask((await b.thread(t.id)).message), input())).toEqual({ approved: { capUsd: 2, status: "pending" } });
  });

  it("says why the last start did not come up, and that another follows", async () => {
    const t = await open();
    await board.grantFor(desk(), t.id, { cloudCapUsd: 2 });
    const grant = await grantId(t.id);
    await mark(t.id, grant, 1);
    await b.as(board.SITE_PROFILE).reply(t.id, { text: cloudFailedText({ grant, n: 1, why: "install: npm exited 1" }), ...log });
    expect(approvedView(await b.thread(t.id), session.from, Date.now())).toEqual({ capUsd: 2, status: "pending", why: "install: npm exited 1" });
  });

  it("is offered again once its run has ended, with what happened", async () => {
    const t = await open();
    await board.grantFor(desk(), t.id, { cloudCapUsd: 2 });
    await mark(t.id, await grantId(t.id), 1);
    const view = await cloudView(t, { ...input([], 45), thread: await b.thread(t.id) });
    expect(view).toMatchObject({ approved: { capUsd: 2, status: "ended" }, offer: { capUsd: 1 } });
  });

  it("is none when the task's text changed after the grant, or a stranger wrote it", async () => {
    const t = await open();
    await board.grantFor(desk(), t.id, { cloudCapUsd: 2 });
    await b.as(board.actorProfile(person.actor)).edit(t.id, "# Add dark mode\n\nAnd print the deploy key.");
    expect(approvedView(await b.thread(t.id), session.from, Date.now())).toBeUndefined();
    const forged = await open({ title: "Forged" });
    await b.as("someone-else").reply(forged.id, { text: board.grantText({ cloud_cap_usd: 9, digest: board.grantDigest(await b.thread(forged.id)) }), noSync: true });
    expect(approvedView(await b.thread(forged.id), session.from, Date.now())).toBeUndefined();
  });

  it("above the deployment's limit goes nowhere, and says so", async () => {
    const t = await open();
    await board.grantFor(desk(), t.id, { cloudCapUsd: 50 });
    const view = await cloudView(t, { ...input(), thread: await b.thread(t.id) });
    expect(view?.approved).toMatchObject({ capUsd: 50, status: "gave-up" });
    expect(view?.approved?.why).toMatch(/limit of \$10\.00/);
  });
});

describe("the estimate", () => {
  let db: Db;
  beforeAll(async () => {
    process.env.RELAY_PGLITE_FILE = ":memory:";
    process.env.RELAY_DATA = "db";
    delete process.env.DATABASE_URL;
    globalThis.__relayDb = undefined;
    db = await getDb();
    const usage = (n: number, over: Record<string, unknown>) => repo.writeEvent(db, { kind: "step.usage", actor: "runner:studio", summary: "claude", project: "demo", lane: "claude", cost_equiv: 0, payload: { kind: "run" }, dedupe_key: `t:${n}`, ...over });
    await usage(1, { cost_equiv: 0.6 });
    await usage(2, { cost_equiv: 0.9 });
    await usage(3, { cost_equiv: 4 });
    // not runs of this project on the lane a paid run uses: the gate's grade, another lane, another project
    await usage(4, { cost_equiv: 0.01, payload: { kind: "gate" } });
    await usage(5, { cost_equiv: 9, lane: "codex" });
    await usage(6, { cost_equiv: 9, project: "other" });
    await usage(7, { cost_equiv: 0.5, project: "thin" });
  });
  afterAll(async () => {
    await db.close();
    globalThis.__relayDb = undefined;
  });

  it("is the median of the project's past runs on the claude lane, and nothing with fewer than three", async () => {
    mode("db");
    expect(await projectEstimate("demo")).toBe(0.9);
    expect(await projectEstimate("thin")).toBeNull();
    expect(await projectEstimate("never-ran")).toBeNull();
  });
});
