/**
 * The job's nodes path (work/job.ts, `runNodesStage`) on an in-memory board, with a bare git repository holding the
 * workflow and a stubbed nodes runner (no engine): manifest -> run -> each output attached to the thread with a
 * `relay-asset@1` block (one more version on a re-run) -> usage per model -> held for review. Then the failures:
 * no manifest, a workflow outside the clone, a run with no output, an engine error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@vercel/board";
import { HOLD } from "../src/board/mapping.ts";
import { ASSET_SCHEMA, blocksOf, ensureSchemas, type AssetBlock } from "../src/board/schemas.ts";
import { getTask, openTask, requestChanges } from "../src/board/tasks.ts";
import type { NodesResult } from "../src/lanes/nodes.ts";
import { runJob, type GitHost, type JobOptions, type NodesRunner } from "../src/work/job.ts";
import { memoryBoard } from "./helpers/board.ts";
import { fakeHost, makeOrigin, type Origin } from "./helpers/repo.ts";

const MANIFEST = "```relay-nodes\nworkflow: workflows/cutscene.py\ninputs:\n  Start Flow:\n    prompt: a rainy street\noutputs: [End Flow]\nstage: cutscene\n```";
let origin: Origin;
beforeAll(() => {
  origin = makeOrigin({ "workflows/cutscene.py": "# /// script\n# [tool.griptape-nodes]\n# name = 'cutscene'\n# ///\n" });
});
afterAll(() => origin.remove());

/** A runner that writes the files a real run would and reports them, with the request it saw. */
function stubRunner(outputs: Array<{ parameter: string; ext: string; mime: string; content: string }>, extra: Partial<NodesResult> = {}): NodesRunner & { seen: Parameters<NodesRunner>[0][] } {
  const seen: Parameters<NodesRunner>[0][] = [];
  const run: NodesRunner = async (req) => {
    seen.push(req);
    mkdirSync(req.outDir, { recursive: true });
    const outs = outputs.map((o) => {
      const path = join(req.outDir, `End_Flow-${o.parameter}.${o.ext}`);
      writeFileSync(path, o.content);
      return { node: "End Flow", parameter: o.parameter, path, mime: o.mime, bytes: o.content.length };
    });
    const nodesRun = [{ node: "Seedance", type: "Seedance20VideoGeneration" }, { node: "End Flow", type: "EndFlow" }];
    const usage = outs.some((o) => o.mime.startsWith("video/")) ? [{ lane: "video" as const, model: "bytedance/seedance-2.0", nodeType: "Seedance20VideoGeneration", outputs: outs.filter((o) => o.mime.startsWith("video/")).length, seconds: 8, costEquiv: 0, costKnown: false, durationMs: 1200 }] : [];
    return { ok: true, outputs: outs, nodesRun, libraries: ["Griptape Nodes Library"], engineVersion: "0.62.2", durationMs: 1200, usage, interpreter: ["python"], ...extra };
  };
  return Object.assign(run, { seen });
}

const clear = async () => ({ verdict: "clear" as const, score: 0, reasons: [], grader: "off" as const, model: null });

async function rig(body = `A rainy street at night.\n\n${MANIFEST}`) {
  const board = memoryBoard();
  await ensureSchemas(board);
  const worker = board.as("relay-studio-nodes");
  // the nodes lane attaches to the thread: it must never push or open a pull request
  const never = (what: string) => async (): Promise<never> => {
    throw new Error(`the nodes lane must not ${what}`);
  };
  const host: GitHost = { ...fakeHost(origin), push: never("push"), findPr: never("look for a PR"), createPr: never("open a PR"), comment: never("comment on a PR") };
  const task = await openTask(board, { project: "prod", repo: "acme/prod", title: "Cutscene 3", body, lane: "nodes" });
  const { principal } = await board.me();
  const job = (nodes: NodesRunner): JobOptions => ({ board: worker, lane: "nodes", workerName: "studio", trusted: [principal, "board:client:relay-studio-nodes"], home: origin.home, gitHost: host, nodes, gate: clear, timeoutMs: 60_000 });
  return { board, worker, task, job };
}

const assetsOf = async (board: Board, id: string) => (await getTask(board, id)).thread.replies.flatMap((m) => blocksOf<AssetBlock>(m, ASSET_SCHEMA).map((a) => ({ ...a, file: m.attachments.find((f) => f.id === a.attachment)?.name })));

describe("runJob on the nodes lane", () => {
  it("runs the manifest's workflow from the clone, attaches each output to the thread, reports usage per model and holds for review", async () => {
    const r = await rig();
    const runner = stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "MP4DATA" }, { parameter: "still", ext: "png", mime: "image/png", content: "PNGDATA!" }]);
    const out = await runJob(await r.worker.tasks.claim(r.task.id), r.job(runner));
    expect(out.outcome).toBe("review");
    expect(out.pr).toBeUndefined();
    expect(runner.seen[0]).toMatchObject({ inputs: { "Start Flow": { prompt: "a rainy street" } }, outputs: ["End Flow"], project: "prod", task: r.task.id });
    expect(runner.seen[0]!.workflow.endsWith("/workflows/cutscene.py")).toBe(true);
    const assets = await assetsOf(r.board, r.task.id);
    expect(assets.map((a) => [a.node, a.parameter, a.index, a.version, a.mime, a.bytes, a.file, a.stage, a.workflow])).toEqual([
      ["End Flow", "video", 1, 1, "video/mp4", 7, "End_Flow-video.mp4", "cutscene", "workflows/cutscene.py"],
      ["End Flow", "still", 1, 1, "image/png", 8, "End_Flow-still.png", "cutscene", "workflows/cutscene.py"],
    ]);
    expect(await (await r.board.download(assets[0]!.attachment)).text()).toBe("MP4DATA");
    const d = await getTask(r.board, r.task.id);
    expect(d.task).toMatchObject({ state: "review", pr: null, hold: { kind: HOLD.review, reason: "2 outputs to review" } });
    expect(d.usage.map((u) => [u.kind, u.lane, u.model, u.tool])).toEqual([["run", "nodes", "bytedance/seedance-2.0", "griptape-nodes"], ["media", "video", "bytedance/seedance-2.0", "griptape-nodes"]]);
    expect(d.thread.replies.find((m) => m.labels.relay === "result")!.text).toMatch(/Workflow workflows\/cutscene\.py ran on Griptape Nodes 0\.62\.2 in 1s and produced 2 outputs\. Models: video: bytedance\/seedance-2\.0 x1 \(cost unknown\)\./);
  });

  it("a re-run after a rejection is one more version of the same end-node parameter", async () => {
    const r = await rig();
    const runner = stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "TAKE1" }]);
    await runJob(await r.worker.tasks.claim(r.task.id), r.job(runner));
    await r.board.reply(r.task.id, { text: "too dark, lift the shadows", labels: { relay: "note" } });
    await r.board.tasks.unblock(r.task.id);
    await runJob(await r.worker.tasks.claim(r.task.id), r.job(stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "TAKE2!" }])));
    expect((await assetsOf(r.board, r.task.id)).map((a) => [a.parameter, a.version, a.bytes])).toEqual([["video", 1, 5], ["video", 2, 6]]);
    expect((await getTask(r.board, r.task.id)).task.state).toBe("review");
  });

  it("a task without a manifest fails and says so, with no engine run and nothing attached", async () => {
    const r = await rig("A rainy street at night, no manifest.");
    const runner = stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "x" }]);
    const out = await runJob(await r.worker.tasks.claim(r.task.id), r.job(runner));
    expect(out.outcome).toBe("failed");
    expect(out.error).toMatch(/relay-nodes/);
    expect(runner.seen).toEqual([]);
    expect(await assetsOf(r.board, r.task.id)).toEqual([]);
    expect((await getTask(r.board, r.task.id)).task.state).toBe("failed");
  });

  it("a workflow that is not in the repository is refused before the engine runs", async () => {
    const r = await rig(MANIFEST.replace("workflows/cutscene.py", "workflows/missing.py"));
    const runner = stubRunner([]);
    const out = await runJob(await r.worker.tasks.claim(r.task.id), r.job(runner));
    expect(out).toMatchObject({ outcome: "failed", error: "workflow workflows/missing.py is not a file in acme/prod" });
    expect(runner.seen).toEqual([]);
  });

  it("a run that produced nothing, and an engine failure, fail the task with the reason and the usage still in the thread", async () => {
    const r = await rig();
    const none = await runJob(await r.worker.tasks.claim(r.task.id), r.job(stubRunner([], { warning: "End Flow had no file outputs" })));
    expect(none).toMatchObject({ outcome: "failed", error: "produced no output (End Flow had no file outputs)" });
    const r2 = await rig();
    const boom = await runJob(await r2.worker.tasks.claim(r2.task.id), r2.job(stubRunner([], { ok: false, error: "Seedance20VideoGeneration: 402 insufficient credits", usage: [{ lane: "video", model: "bytedance/seedance-2.0", nodeType: "Seedance20VideoGeneration", outputs: 0, seconds: null, costEquiv: 0, costKnown: false, durationMs: 400 }] })));
    expect(boom).toMatchObject({ outcome: "failed", error: "Seedance20VideoGeneration: 402 insufficient credits" });
    const d = await getTask(r2.board, r2.task.id);
    expect(d.task.reason).toBe("Seedance20VideoGeneration: 402 insufficient credits");
    expect(d.usage.map((u) => u.kind)).toEqual(["run", "media"]);
  });

  it("request changes on a nodes task has no pull request to comment on and still returns it to the queue", async () => {
    const r = await rig();
    await runJob(await r.worker.tasks.claim(r.task.id), r.job(stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "x" }])));
    expect((await requestChanges(r.board, undefined, r.task.id, "wrong aspect ratio")).state).toBe("queued");
  });
});
