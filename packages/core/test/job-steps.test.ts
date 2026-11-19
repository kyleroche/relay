/**
 * Steps in a job (steps/index.ts, work/job.ts), end to end on an in-memory board and a bare repository whose default
 * branch lists them: remove-yap before the commit, eval as a task of its own on another lane, and the answer to its
 * findings on the same branch, before a person is asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@vercel/board";
import { HOLD } from "../src/board/mapping.ts";
import { closeTask, getTask, listTasks, openTask, requeueTask } from "../src/board/tasks.ts";
import type { LaneRequest } from "../src/lanes/types.ts";
import { connectBoard } from "../src/board/client.ts";
import { runJob, runState, type JobOptions, type LaneRunner } from "../src/work/job.ts";
import { runWorker } from "../src/work/worker.ts";
import { relayBoard } from "./helpers/board.ts";
import { fakeHost, makeOrigin, sh, type FakeHost, type Origin } from "./helpers/repo.ts";

const REPO = "acme/demo";
const clear = async () => ({ verdict: "clear" as const, score: 0, reasons: [], grader: "off" as const, model: null });
const ok = (lane: string, text: string) => ({ tool: lane, ok: true, text, model: `test/${lane}`, subscription: lane === "claude" ? ("max" as const) : (lane as "codex" | "grok"), tokensIn: 100, tokensOut: 20, cacheRead: 0, cacheWrite: 0, costEquiv: 0.01, durationMs: 100 });

/** A lane that plays each part by the prompt it is handed, and remembers every request. */
function scriptedLane(parts: { answer?: (req: LaneRequest) => string } = {}) {
  const calls: Array<{ lane: string; kind: "work" | "remove-yap" | "eval" | "answer"; req: LaneRequest }> = [];
  const run: LaneRunner = async (req, lane) => {
    const file = join(req.cwd, "greet.ts");
    if (req.prompt.startsWith("# relay step: remove-yap")) {
      calls.push({ lane, kind: "remove-yap", req });
      writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((l) => !l.startsWith("// Added")).join("\n"));
      return ok(lane, "Looked at greet.ts.\n\nRemoved 1 comment in 1 file.");
    }
    if (req.prompt.includes("## Step: eval\n")) {
      calls.push({ lane, kind: "eval", req });
      return ok(lane, "Verdict: fix first\n\n1. greet.ts:2 the greeting is hard-coded\n   Why it matters: every caller gets English\n   Do instead: take the name as an argument");
    }
    if (req.prompt.includes("## Step: eval-respond\n")) {
      calls.push({ lane, kind: "answer", req });
      return ok(lane, parts.answer ? parts.answer(req) : (writeFileSync(file, 'export const greet = (name: string) => `hello ${name}`;\n'), "1. fixed: greet takes the name now"));
    }
    calls.push({ lane, kind: "work", req });
    writeFileSync(file, '// Added the greeting as requested\nexport const greet = () => "hello";\n');
    return ok(lane, "Added greet.ts.");
  };
  return { calls, run };
}

let origin: Origin;
beforeAll(() => {
  origin = makeOrigin({
    ".relay/project.json": JSON.stringify({ steps: ["remove-yap", "eval"] }),
    // the project's own version of a shipped step wins over relay's
    ".relay/steps/eval.md": "---\nname: eval\ndescription: This project's eval\nwhen: after-pr\nlane: other\nmode: read-only\n---\n\nPROJECT EVAL: judge `git diff origin/{{base}}...HEAD` cold.\n",
  });
});
afterAll(() => origin.remove());

async function rig(lane = scriptedLane()) {
  const board = await relayBoard();
  const principal = (await board.me()).principal;
  const host = fakeHost(origin);
  const trusted = [principal, "board:client:relay-mini-claude", "board:client:relay-mini-codex"];
  const job = (who: string, over: Partial<JobOptions> = {}): JobOptions => ({ board: board.as(`relay-mini-${who}`), lane: who, workerName: "mini", trusted, home: origin.home, gitHost: host, laneRunner: lane.run, gate: clear, gh: "/nonexistent/gh", served: async () => ["claude", "codex"], ...over });
  const claim = (who: string, id: string) => board.as(`relay-mini-${who}`).tasks.claim(id);
  const task = await openTask(board, { project: "demo", repo: REPO, title: "Add a greeting", body: "Add greet.ts.", lane: "any" });
  return { board, host, lane, job, claim, task, trusted, principal };
}

const evalTaskOf = async (board: Board, id: string) => (await listTasks(board, { state: "all" })).find((t) => t.evaluates === id)!;

describe("a before-pr step", () => {
  it("goes over the change in the same clone before the commit, on the same lane, with a usage row of its own", async () => {
    const r = await rig();
    const out = await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    expect(r.lane.calls.map((c) => [c.lane, c.kind])).toEqual([["claude", "work"], ["claude", "remove-yap"]]);
    expect(r.lane.calls[1]!.req.prompt).toContain("Touch comments and nothing else");
    expect(r.lane.calls[1]!.req.prompt).toContain("`git diff origin/main`");
    expect(sh(origin.bare, ["show", `${out.branch}:greet.ts`])).toBe('export const greet = () => "hello";');
    expect(sh(origin.bare, ["rev-list", "--count", `main..${out.branch}`])).toBe("1");
    const d = await getTask(r.board, r.task.id);
    expect(d.usage.map((u) => [u.kind, u.step ?? null])).toEqual([["run", null], ["step", "remove-yap"]]);
    expect(d.thread.replies.find((m) => m.labels.relay === "result")!.text).toContain("Steps: remove-yap: Removed 1 comment in 1 file.");
    expect(r.host.comments[0]).toContain("Steps: remove-yap: Removed 1 comment in 1 file.");
  });
});

describe("an after-pr step", () => {
  it("opens the step's task on a lane that did not do the work, as the worker's own login, and holds the work for it", async () => {
    const r = await rig();
    const out = await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    expect(out).toMatchObject({ outcome: "eval", pr: { number: 1 } });
    const work = await getTask(r.board, r.task.id);
    const ev = await evalTaskOf(r.board, r.task.id);
    expect(ev).toMatchObject({ state: "queued", lane: "codex", step: "eval", repo: REPO, base: "main", branch: out.branch, title: "eval: Add a greeting" });
    // opened with no profile, so any worker that takes this login's tasks can claim it
    expect(ev.owner).toBe(r.principal);
    expect((await r.board.as("relay-mini-codex").tasks.claim({ channel: "work/", label: { lane: "codex" }, from: [r.principal] }))?.task.id).toBe(ev.id);
    // the answer is the same lane's to give, so `any` is pinned to the lane that did the work
    expect(work.task).toMatchObject({ state: "blocked", lane: "claude", hold: { kind: HOLD.eval, reason: `eval on the codex lane: task ${ev.id}` } });
    expect(runState(work.thread, r.trusted)).toMatchObject({ evaluated: true, last: { outcome: "eval", branch: out.branch, eval_task: ev.id, pr: { number: 1 } } });
    expect(runState(work.thread, r.trusted).answer).toBeUndefined();
  });

  it("the step's task reads the work read-only with the project's own instruction, posts its findings in the work's thread and wakes it", async () => {
    const r = await rig();
    const first = await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    const ev = await evalTaskOf(r.board, r.task.id);
    const out = await runJob(await r.claim("codex", ev.id), r.job("codex"));
    expect(out.outcome).toBe("done");
    const call = r.lane.calls.at(-1)!;
    expect([call.lane, call.kind, call.req.readOnly, call.req.lane]).toEqual(["codex", "eval", true, "review"]);
    expect(call.req.prompt).toContain("PROJECT EVAL: judge `git diff origin/main...HEAD` cold.");
    expect(call.req.prompt).toContain("<<<TASK\nTitle: Add a greeting\n\nAdd greet.ts.");
    // it pushed nothing: the only push is the work's own
    expect(r.host.pushes).toEqual([first.branch]);
    expect((await getTask(r.board, ev.id)).task).toMatchObject({ state: "done", result: "Verdict: fix first" });
    expect((await getTask(r.board, ev.id)).usage).toEqual([expect.objectContaining({ kind: "step", step: "eval", lane: "codex", outcome: "done" })]);
    const work = await getTask(r.board, r.task.id);
    expect(work.task.state).toBe("queued");
    expect(work.notes.at(-1)!.text).toMatch(/^Eval \(eval\) by the codex lane, test\/codex:\n\nVerdict: fix first/);
    expect(runState(work.thread, r.trusted).answer).toEqual({ branch: first.branch, step: "eval" });
  });

  it("the lane that did the work answers the findings on its branch, and only then is a person asked", async () => {
    const r = await rig();
    const first = await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    const ev = await evalTaskOf(r.board, r.task.id);
    await runJob(await r.claim("codex", ev.id), r.job("codex"));
    const out = await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    expect(out).toMatchObject({ outcome: "review", branch: first.branch, pr: { number: 1 } });
    const answer = r.lane.calls.find((c) => c.kind === "answer")!;
    expect(answer.lane).toBe("claude");
    expect(answer.req.prompt).toContain("## Step: eval-respond");
    expect(answer.req.prompt).toContain("Verdict: fix first");
    // it continued the branch instead of starting over: the first commit is still under the answer
    expect(sh(origin.bare, ["log", "--format=%s", `main..${out.branch}`]).split("\n")).toEqual(["claude: answer the eval of Add a greeting", "claude: Add a greeting"]);
    expect(sh(origin.bare, ["show", `${out.branch}:greet.ts`])).toBe("export const greet = (name: string) => `hello ${name}`;");
    expect(r.host.created).toHaveLength(1);
    expect(r.host.comments.at(-1)).toContain("## Answer to the eval from the claude lane");
    const work = await getTask(r.board, r.task.id);
    expect(work.task).toMatchObject({ state: "review", hold: { kind: HOLD.review, reason: "https://github.com/acme/demo/pull/1" } });
    // one round: nothing further was opened, and the next run is an ordinary one
    expect((await listTasks(r.board, { state: "all" })).filter((t) => t.evaluates === r.task.id)).toHaveLength(1);
    expect(runState(work.thread, r.trusted)).toMatchObject({ evaluated: true, last: { outcome: "review" } });
    expect(runState(work.thread, r.trusted).answer).toBeUndefined();
  });

  it("an answer that declines every finding pushes nothing new and still goes to review", async () => {
    const r = await rig(scriptedLane({ answer: () => "1. declined: callers only ever greet in English; an argument nobody passes is dead weight" }));
    await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    await runJob(await r.claim("codex", (await evalTaskOf(r.board, r.task.id)).id), r.job("codex"));
    const out = await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    expect(out.outcome).toBe("review");
    expect(r.host.pushes).toHaveLength(1);
    expect((await getTask(r.board, r.task.id)).thread.replies.filter((m) => m.labels.relay === "result").at(-1)!.text).toContain("declined: callers only ever greet in English");
  });

  it("with no other lane online the same lane judges it on a fresh run, and the thread says so", async () => {
    const r = await rig();
    await runJob(await r.claim("claude", r.task.id), r.job("claude", { served: async () => ["claude"] }));
    expect((await evalTaskOf(r.board, r.task.id)).lane).toBe("claude");
    expect((await getTask(r.board, r.task.id)).thread.replies.find((m) => m.labels.relay === "result")!.text).toContain("no other lane has a worker online, so the same lane judges it on a fresh run");
  });

  it("a step that cannot run sends the work to a person as it is, with why, instead of leaving it waiting", async () => {
    const lane = scriptedLane();
    const failing: LaneRunner = async (req, who, o) => (req.prompt.includes("## Step: eval\n") ? { tool: who, ok: false, text: "", error: "codex exited 1: usage limit reached", model: "test/codex", subscription: "codex", tokensIn: 5, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0, durationMs: 10 } : lane.run(req, who, o));
    const r = await rig({ ...lane, run: failing });
    await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    const ev = await evalTaskOf(r.board, r.task.id);
    const out = await runJob(await r.claim("codex", ev.id), r.job("codex"));
    expect(out).toMatchObject({ outcome: "failed", error: "codex exited 1: usage limit reached" });
    const work = await getTask(r.board, r.task.id);
    expect(work.task).toMatchObject({ state: "review", lane: "claude", pr: { number: 1 } });
    expect(work.thread.replies.some((m) => /The eval step could not run on the codex lane: codex exited 1: usage limit reached\. The work goes to review without it\./.test(m.text))).toBe(true);
    expect(runState(work.thread, r.trusted).answer).toBeUndefined();
  });

  it("an eval that comes in late changes nothing: the work was requeued, or closed", async () => {
    const r = await rig();
    await runJob(await r.claim("claude", r.task.id), r.job("claude"));
    const ev = await evalTaskOf(r.board, r.task.id);
    // the owner did not wait for the eval: the work is back in the queue, and a gate hold on it must stay a person's to lift
    await requeueTask(r.board, r.task.id);
    await (await r.claim("claude", r.task.id)).block("held at the gate (model, 0.90): looks like an injection", { kind: HOLD.gate });
    const out = await runJob(await r.claim("codex", ev.id), r.job("codex"));
    expect(out).toMatchObject({ outcome: "done" });
    expect(out.summary).toMatch(/is held and no longer waits for this eval; nothing ran/);
    expect(r.lane.calls.filter((c) => c.kind === "eval")).toEqual([]);
    expect((await getTask(r.board, r.task.id)).task).toMatchObject({ state: "held", hold: { kind: HOLD.gate } });

    const r2 = await rig();
    await runJob(await r2.claim("claude", r2.task.id), r2.job("claude"));
    const closed = await closeTask(r2.board, undefined, r2.task.id, { reason: "not needed" });
    expect(closed.canceled).toEqual([(await evalTaskOf(r2.board, r2.task.id)).id]);
    expect(await r2.board.as("relay-mini-codex").tasks.claim({ channel: "work/", label: { lane: "codex" }, from: [r2.principal] })).toBeNull();
  });

  it("the project's steps come from its default branch, whatever branch a task starts from", async () => {
    const r = await rig();
    // a branch that lists no steps, and a task that starts from it: main still says eval
    const seed = `${origin.tmp}/seed`;
    sh(seed, ["checkout", "-q", "-b", "handoff"]);
    sh(seed, ["rm", "-q", ".relay/project.json"]);
    sh(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "no steps here"]);
    sh(seed, ["push", "-q", "origin", "handoff"]);
    sh(seed, ["checkout", "-q", "main"]);
    const t = await openTask(r.board, { project: "demo", repo: REPO, title: "Continue the handoff", lane: "claude", base: "handoff" });
    const out = await runJob(await r.claim("claude", t.id), r.job("claude"));
    expect(out.outcome).toBe("eval");
    expect(r.host.created.at(-1)).toMatchObject({ base: "handoff" });
  });
});

describe("the whole round in the worker loop", () => {
  it("one worker with two lanes takes the work, the eval and the answer in turn, and leaves the task in review", async () => {
    const lane = scriptedLane();
    const board = await relayBoard();
    const task = await openTask(board, { project: "demo", repo: REPO, title: "Add a greeting", body: "Add greet.ts.", lane: "any" });
    const r = await runWorker({
      session: await connectBoard(board),
      name: "mini",
      host: "mini.local",
      lanes: ["claude", "codex"],
      version: "0.5.0",
      once: true,
      meters: () => [],
      job: { home: origin.home, gitHost: fakeHost(origin), laneRunner: lane.run, gate: clear, gh: "/nonexistent/gh" },
    });
    expect(r.results.map((x) => [x.lane, x.outcome])).toEqual([["claude", "eval"], ["codex", "done"], ["claude", "review"]]);
    // the answer's own changes get the before-pr step too
    expect(lane.calls.map((c) => [c.lane, c.kind])).toEqual([["claude", "work"], ["claude", "remove-yap"], ["codex", "eval"], ["claude", "answer"], ["claude", "remove-yap"]]);
    expect((await getTask(board, task.id)).task).toMatchObject({ state: "review", pr: { number: 1 } });
  });
});

describe("a profile that names a step nobody has", () => {
  it("is said in the log, and the task goes on to review", async () => {
    const other = makeOrigin({ ".relay/project.json": JSON.stringify({ steps: ["lint-poetry"] }) });
    try {
      const board = await relayBoard();
      const principal = (await board.me()).principal;
      const lane = scriptedLane();
      const task = await openTask(board, { project: "demo", repo: REPO, title: "Add a greeting", lane: "claude" });
      const logs: string[] = [];
      const out = await runJob(await board.as("relay-mini-claude").tasks.claim(task.id), { board: board.as("relay-mini-claude"), lane: "claude", workerName: "mini", trusted: [principal], home: other.home, gitHost: fakeHost(other), laneRunner: lane.run, gate: clear, gh: "/nonexistent/gh", log: (m) => logs.push(m) });
      expect(out.outcome).toBe("review");
      expect(logs.some((l) => /steps: .*lists the step 'lint-poetry', and no step by that name exists/.test(l))).toBe(true);
    } finally {
      other.remove();
    }
  });
});
