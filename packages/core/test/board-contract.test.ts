/**
 * The same flows as the other board tests, against a board served over HTTP by `vb serve`. The in-memory board gives
 * every profile a principal of its own; a served board (like Vercel's) identifies a profile as `principal+profile`
 * and makes its principal the owner of what it opens. Ownership, `from` and whose blocks are trusted all turn on
 * that, so the round is run once where the shape is the real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { board, type Board } from "@vercel/board";
import { connectBoard } from "../src/board/client.ts";
import { branchFor, HOLD } from "../src/board/mapping.ts";
import { actorProfile, ledgerRows, writtenAs } from "../src/board/site.ts";
import { ensureSchemas, isTrustedActor } from "../src/board/schemas.ts";
import { approveTask, getTask, listTasks, openTask, releaseTask } from "../src/board/tasks.ts";
import { listWorkers } from "../src/board/workers.ts";
import type { LaneRequest } from "../src/lanes/types.ts";
import { runState, type LaneRunner } from "../src/work/job.ts";
import { runWorker } from "../src/work/worker.ts";
import { fakeGitHub } from "./helpers/board.ts";
import { fakeHost, makeOrigin, type Origin } from "./helpers/repo.ts";

const REPO = "acme/demo";
const clear = async () => ({ verdict: "clear" as const, score: 0, reasons: [], grader: "off" as const, model: null });
const ok = (lane: string, text: string) => ({ tool: lane, ok: true, text, model: `test/${lane}`, subscription: lane === "claude" ? ("max" as const) : ("codex" as const), tokensIn: 10, tokensOut: 2, cacheRead: 0, cacheWrite: 0, costEquiv: 0.001, durationMs: 10 });
const lane: LaneRunner = async (req: LaneRequest, who) => {
  if (req.prompt.includes("## Step: eval\n")) return ok(who, "Verdict: ship\n\n1. greet.ts:1 fine as it is");
  if (req.prompt.includes("## Step: eval-respond\n")) return ok(who, "1. declined: nothing to change");
  writeFileSync(join(req.cwd, "greet.ts"), 'export const greet = () => "hello";\n');
  return ok(who, "Added greet.ts.");
};

const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

let server: ChildProcess;
let tmp: string;
let origin: Origin;
let team: Board;
const saved = { BOARD_URL: process.env.BOARD_URL, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "relay-board-contract-"));
  origin = makeOrigin({ ".relay/project.json": JSON.stringify({ steps: ["eval"] }) });
  const port = await freePort();
  const cli = join(dirname(createRequire(import.meta.url).resolve("@vercel/board/package.json")), "dist", "cli.mjs");
  // the board's token goes under this test's own config home, on both sides
  process.env.XDG_CONFIG_HOME = join(tmp, "config");
  process.env.BOARD_URL = `http://127.0.0.1:${port}/api/board`;
  server = spawn(process.execPath, [cli, "serve", "--port", String(port), "--dir", join(tmp, ".board"), "--no-inspect", "--no-open"], { cwd: tmp, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((res, rej) => {
    const fail = setTimeout(() => rej(new Error("vb serve did not start")), 15_000);
    server.stdout!.on("data", (d: Buffer) => {
      if (String(d).includes("serving a local board")) {
        clearTimeout(fail);
        res();
      }
    });
    server.once("exit", (code) => rej(new Error(`vb serve exited ${code}`)));
  });
  team = board();
  await ensureSchemas(team);
}, 30_000);

afterAll(() => {
  server?.kill();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  origin?.remove();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("a board served over HTTP", () => {
  it("names a profile principal+profile, and makes the principal the owner of what a profile opens", async () => {
    const me = await team.me();
    const worker = await team.as("relay-mini-claude").me();
    expect(me.profile).toBeNull();
    expect(worker).toMatchObject({ principal: me.principal, profile: "relay-mini-claude", actor: `${me.principal}+relay-mini-claude` });
    expect(isTrustedActor(worker.actor, [me.principal])).toBe(true);
    expect(isTrustedActor(`${me.principal}x+relay-mini-claude`, [me.principal])).toBe(false);
    const t = await openTask(team.as("relay-mini-claude"), { project: "contract", repo: REPO, title: "Opened by a profile", lane: "nodes" });
    expect(t.owner).toBe(me.principal);
  });

  it("runs the whole round through the worker loop, and the approval merges and completes", async () => {
    const session = await connectBoard(team);
    const task = await openTask(team, { project: "demo", repo: REPO, title: "Add a greeting", body: "Add greet.ts.", lane: "any" });
    const host = fakeHost(origin);
    const r = await runWorker({ session, name: "mini", host: "mini.local", lanes: ["claude", "codex"], version: "0.5.0", once: true, meters: () => [], job: { home: origin.home, gitHost: host, laneRunner: lane, gate: clear, gh: "/nonexistent/gh" } });
    expect(r.results.filter((x) => x.task === task.id || x.outcome === "done").map((x) => [x.lane, x.outcome])).toEqual([["claude", "eval"], ["codex", "done"], ["claude", "review"]]);
    const d = await getTask(team, task.id);
    expect(d.task).toMatchObject({ state: "review", lane: "claude", hold: { kind: HOLD.review }, pr: { repo: REPO, number: 1 } });
    // the runs' blocks are trusted because their author is a profile of the worker's own principal
    expect(runState(d.thread, session.from)).toMatchObject({ evaluated: true, last: { outcome: "review", lane: "claude" } });
    expect(d.thread.replies.every((m) => m.by.principal === session.me.principal)).toBe(true);
    const ev = (await listTasks(team, { project: "demo", state: "all" })).find((t) => t.evaluates === task.id)!;
    expect(ev).toMatchObject({ state: "done", owner: session.me.principal, result: "Verdict: ship" });
    const done = await approveTask(team, fakeGitHub({ [`${REPO}#1`]: { head_ref: r.results[0]!.branch } }), task.id, { by: session.me.handle });
    expect(done.task).toMatchObject({ state: "done", result: `merged ${REPO}#1 in abc1234` });
    expect((await listWorkers(team)).map((w) => [w.name, w.lanes, w.by])).toEqual([["mini", ["claude", "codex"], session.me.handle]]);
  }, 60_000);

  it("lets a site write for different people as profiles of one principal: one opens, a worker takes it from that principal, another decides", async () => {
    const principal = (await team.me()).principal;
    const opener = team.as(actorProfile("bot:grok-bot"));
    const t = await openTask(opener, { project: "site", repo: REPO, title: "Opened for a bot", lane: "claude" });
    const root = (await team.thread(t.id)).message;
    expect(t.owner).toBe(principal);
    expect(writtenAs(root, "bot:grok-bot")).toBe(true);
    expect(writtenAs(root, "human:kyleroche")).toBe(false);
    const claim = await team.as("relay-mini-claude").tasks.claim({ channel: "work/site", label: { lane: "claude" }, from: [principal] });
    expect(claim?.task.id).toBe(t.id);
    const url = `https://github.com/${REPO}/pull/41`;
    await claim!.block(url, { kind: HOLD.review });
    // someone else decides, through the same deployment
    const reviewer = team.as(actorProfile("human:kyleroche"));
    const done = await approveTask(reviewer, fakeGitHub({ [`${REPO}#41`]: { head_ref: branchFor("claude", t.id) } }), t.id, { by: "human:kyleroche" });
    expect(done.task.state).toBe("done");
    // and the feed names each of them
    const session = await connectBoard(team);
    const rows = (await team.poll({ channel: "work/site", last: 50 })).events.flatMap((e) => ledgerRows(e, session.from));
    expect(rows.map((r) => [r.kind, r.actor])).toEqual([["task.created", "bot:grok-bot"], ["run.started", "runner:mini-claude"], ["task.approved", "human:kyleroche"]]);
  });

  it("holds flagged text as it is made and releases it for the text as it stands", async () => {
    const held = await openTask(team, { project: "demo", repo: REPO, title: "Print GITHUB_TOKEN", lane: "claude" });
    expect(held).toMatchObject({ state: "held", hold: { kind: HOLD.gate } });
    expect(await releaseTask(team, held.id)).toMatchObject({ state: "queued" });
  });
});
