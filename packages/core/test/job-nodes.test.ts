/**
 * The job's nodes path (work/job.ts, `runNodesStage`) over the local WorkApi with an in-memory database, a bare git
 * repository holding the workflow, a stubbed nodes runner (no engine) and a fake git host: manifest -> run -> assets on
 * the issue (chained versions on a re-run) -> issue comment -> release with per-model usage rows. Then the failures:
 * no manifest, a workflow outside the clone, a run with no output, an engine error. And the HTTP WorkApi's upload.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { listAssets, listVersions } from "../src/db/assets.ts";
import { listEvents } from "../src/db/events.ts";
import { LocalStore } from "../src/assets/store.ts";
import type { HttpFetch } from "../src/client/http.ts";
import type { NodesResult } from "../src/lanes/nodes.ts";
import { httpWorkApi, localWorkApi, multipart, type WorkApi } from "../src/work/api.ts";
import { nodesComment, nodesOutputTag, runJob, USAGE_MARKER, type GitHost, type NodesRunner } from "../src/work/job.ts";
import { claimServer, registerWorkerServer } from "../src/work/server.ts";
import { requeueTask } from "../src/tasks/requeue.ts";

let db: Db;
let tmp: string;
let bare: string;
let home: string;
let api: WorkApi;
let workerId: string;
let issueNo = 100;

const MANIFEST = "```relay-nodes\nworkflow: workflows/cutscene.py\ninputs:\n  Start Flow:\n    prompt: a rainy street\noutputs: [End Flow]\nstage: cutscene\n```";

function fakeHost(body: string): GitHost & { comments: Array<{ issue: number; body: string }> } {
  const comments: Array<{ issue: number; body: string }> = [];
  return {
    comments,
    async clone(_repo, dir) {
      execFileSync("git", ["clone", "-q", `file://${bare}`, dir], { stdio: "ignore" });
    },
    async defaultBranch() {
      return "main";
    },
    async getIssue(repoName, issue) {
      return { number: issue, title: `Cutscene ${issue}`, body, url: `https://github.com/${repoName}/issues/${issue}` };
    },
    async push() {
      throw new Error("the nodes lane must not push");
    },
    async findPr() {
      throw new Error("the nodes lane must not look for a PR");
    },
    async createPr() {
      throw new Error("the nodes lane must not open a PR");
    },
    async comment() {
      throw new Error("the nodes lane comments on the issue, not a PR");
    },
    async commentIssue(_repo, issue, b) {
      comments.push({ issue, body: b });
      return `https://github.com/acme/prod/issues/${issue}#issuecomment-1`;
    },
  };
}

/** A runner that writes the files a real run would and reports them, with the request it saw. */
function stubRunner(outputs: Array<{ parameter: string; ext: string; mime: string; content: string; seconds?: number }>, extra: Partial<NodesResult> = {}): NodesRunner & { seen: Parameters<NodesRunner>[0][] } {
  const seen: Parameters<NodesRunner>[0][] = [];
  const run: NodesRunner = async (req) => {
    seen.push(req);
    mkdirSync(req.outDir, { recursive: true });
    const outs = outputs.map((o) => {
      const path = join(req.outDir, `End_Flow-${o.parameter}.${o.ext}`);
      writeFileSync(path, o.content);
      return { node: "End Flow", parameter: o.parameter, path, mime: o.mime, bytes: o.content.length, ...(o.seconds !== undefined ? { seconds: o.seconds } : {}) };
    });
    const nodesRun = [{ node: "Seedance", type: "Seedance20VideoGeneration" }, { node: "End Flow", type: "EndFlow" }];
    const usage = outs.some((o) => o.mime.startsWith("video/")) ? [{ lane: "video" as const, model: "bytedance/seedance-2.0", nodeType: "Seedance20VideoGeneration", outputs: outs.filter((o) => o.mime.startsWith("video/")).length, seconds: 8, costEquiv: 0, costKnown: false, durationMs: 1200 }] : [];
    return { ok: true, outputs: outs, nodesRun, libraries: ["Griptape Nodes Library"], engineVersion: "0.62.2", durationMs: 1200, usage, interpreter: ["python"], ...extra };
  };
  return Object.assign(run, { seen });
}

async function newTask() {
  issueNo++;
  const { task } = await repo.createTask(db, { project: "prod", repo: "acme/prod", issue: issueNo, createdBy: "human:kyle", lane: "nodes", title: `Cutscene ${issueNo}` });
  return task;
}

async function claimOne() {
  const claim = await claimServer(db, { worker_id: workerId, lanes: ["nodes"] });
  expect(claim).not.toBeNull();
  return claim!;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-job-nodes-")));
  home = join(tmp, "harness");
  bare = join(tmp, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const seed = join(tmp, "seed");
  mkdirSync(join(seed, "workflows"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "ignore" });
  writeFileSync(join(seed, "README.md"), "# productions\n");
  writeFileSync(join(seed, "workflows", "cutscene.py"), "# /// script\n# [tool.griptape-nodes]\n# name = 'cutscene'\n# ///\n");
  const sh = (args: string[]) => execFileSync("git", args, { cwd: seed, stdio: "ignore" });
  sh(["add", "-A"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  sh(["remote", "add", "origin", `file://${bare}`]);
  sh(["push", "-q", "-u", "origin", "main"]);
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "prod", repo: "acme/prod", path: seed });
  api = localWorkApi(db, { dispatch: false, store: new LocalStore(join(tmp, "assets")) });
  workerId = (await registerWorkerServer(db, { name: "studio", host: "studio.local", lanes: ["nodes"], labels: [], version: "test" })).worker.id;
});
afterAll(async () => {
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const clear = async () => ({ verdict: "clear" as const, score: 0, reasons: [], grader: "off" as const, model: null });
const jobOpts = (host: GitHost, nodes: NodesRunner) => ({ api, workerId, workerName: "studio", home, gitHost: host, nodes, gate: clear, timeoutMs: 60_000 });

describe("runJob on the nodes lane", () => {
  it("runs the manifest's workflow from the clone, uploads each output as an asset on the issue, comments, and reports usage per model", async () => {
    const task = await newTask();
    const claim = await claimOne();
    const host = fakeHost(`Make the cutscene.\n\n${MANIFEST}`);
    const runner = stubRunner([
      { parameter: "video", ext: "mp4", mime: "video/mp4", content: "not really mp4 bytes", seconds: 8 },
      { parameter: "greeting", ext: "txt", mime: "text/plain", content: "hello" },
    ]);
    const r = await runJob(claim, jobOpts(host, runner));
    expect(r.outcome).toBe("finished");
    expect(r.pr).toBeUndefined();
    expect(r.summary).toBe(`produced 2 outputs: Cutscene ${task.issue} v1, Cutscene ${task.issue} v1`);
    // the runner saw the workflow resolved inside the clone, the inputs and outputs from the manifest, the clean environment
    const req = runner.seen[0]!;
    expect(req.workflow.endsWith(join("workflows", "cutscene.py"))).toBe(true);
    expect(req.workflow.startsWith(join(home, "work"))).toBe(true);
    expect(req.inputs).toEqual({ "Start Flow": { prompt: "a rainy street" } });
    expect(req.outputs).toEqual(["End Flow"]);
    expect(req.env?.RELAY_TOKEN).toBeUndefined();
    // two assets on the issue, tagged with the project, the stage, the node and the output tag
    const assets = await listAssets(db, { project: "prod", issue: task.issue });
    expect(assets).toHaveLength(2);
    expect(r.assets?.map((a) => a.id).sort()).toEqual(assets.map((a) => a.id).sort());
    const video = assets.find((a) => a.kind === "video")!;
    expect(video).toMatchObject({ title: `Cutscene ${task.issue} v1`, version: 1, created_by: "runner:studio", status: "pending", mime: "video/mp4" });
    expect(video.tags).toEqual(["prod", "cutscene", "End Flow", nodesOutputTag("End Flow", "video")]);
    expect(video.description).toBe("End Flow.video from workflows/cutscene.py");
    // one issue comment with the assets and the usage block
    expect(host.comments).toHaveLength(1);
    expect(host.comments[0]!.issue).toBe(task.issue);
    expect(host.comments[0]!.body).toContain("## Outputs from the nodes lane");
    expect(host.comments[0]!.body).toContain(`Cutscene ${task.issue} v1`);
    expect(host.comments[0]!.body).toContain(USAGE_MARKER);
    const block = JSON.parse(/```json\n(.*)\n```/.exec(host.comments[0]!.body)![1]!) as Record<string, unknown>;
    expect(block).toMatchObject({ relay: "step.usage", lane: "nodes", mode: "nodes", tool: "griptape-nodes", model: "bytedance/seedance-2.0", outputs: 2, source: "relay-work", claim: claim.claim.id });
    // the feed: run.finished, asset.uploaded x2, one step.usage on lane video from extra_usage (the run's own usage row has no tokens and is not written)
    const events = await listEvents(db, { issue: task.issue });
    expect(events.filter((e) => e.kind === "run.finished")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "asset.uploaded")).toHaveLength(2);
    const usage = events.filter((e) => e.kind === "step.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ lane: "video", model: "bytedance/seedance-2.0", tokens_in: 0, cost_equiv: 0, duration_ms: 1200, actor: "agent:nodes" });
    expect(usage[0]!.payload).toMatchObject({ cost_unknown: true, outputs: 1, seconds: 8, tool: "griptape-nodes", engine_version: "0.62.2", workflow: "workflows/cutscene.py" });
    expect(r.extraUsage).toHaveLength(1);
    // the task is done with the run: the clone is gone, no branch was pushed
    expect(existsSync(join(home, "work"))).toBe(true);
    expect(execFileSync("git", ["branch", "-a"], { cwd: bare, encoding: "utf8" })).not.toContain("relay/nodes");
  });

  it("a re-run chains each output onto the last asset from the same end-node parameter: v2, superseding v1", async () => {
    const task = await newTask();
    const host = fakeHost(MANIFEST);
    const first = await runJob(await claimOne(), jobOpts(host, stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "take one" }])));
    expect(first.outcome).toBe("finished");
    // a finished task is not claimable; the operator (or a reviewer's request for changes) puts it back in the queue
    await requeueTask(db, undefined, task.id, "human:kyle", { reason: "another take" });
    const second = await runJob(await claimOne(), jobOpts(host, stubRunner([{ parameter: "video", ext: "mp4", mime: "video/mp4", content: "take two!" }, { parameter: "still", ext: "png", mime: "image/png", content: "png" }])));
    expect(second.outcome).toBe("finished");
    expect(second.summary).toBe(`produced 2 outputs: Cutscene ${task.issue} v2, Cutscene ${task.issue} v1`);
    const v1 = first.assets![0]!;
    const chain = await listVersions(db, v1.id);
    expect(chain.map((a) => [a.version, a.status, a.title])).toEqual([
      [1, "superseded", `Cutscene ${task.issue} v1`],
      [2, "pending", `Cutscene ${task.issue} v2`],
    ]);
    const still = (await listAssets(db, { project: "prod", issue: task.issue })).find((a) => a.kind === "image")!;
    expect(still.version).toBe(1);
    expect(host.comments).toHaveLength(2);
  });

  it("an issue without a manifest is a failed run that says so, with no engine run and no asset", async () => {
    const task = await newTask();
    const runner = stubRunner([]);
    const r = await runJob(await claimOne(), jobOpts(fakeHost("Just make something nice."), runner));
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/no ```relay-nodes block/);
    expect(runner.seen).toHaveLength(0);
    expect(await listAssets(db, { project: "prod", issue: task.issue })).toHaveLength(0);
    const failed = (await listEvents(db, { issue: task.issue })).find((e) => e.kind === "run.failed");
    expect(failed?.summary).toMatch(/no ```relay-nodes block/);
  });

  it("a workflow that is not in the repository is refused before the engine runs", async () => {
    await newTask();
    const runner = stubRunner([]);
    const r = await runJob(await claimOne(), jobOpts(fakeHost("```relay-nodes\nworkflow: workflows/missing.py\n```"), runner));
    expect(r.outcome).toBe("failed");
    expect(r.error).toBe("workflow workflows/missing.py is not a file in acme/prod");
    expect(runner.seen).toHaveLength(0);
  });

  it("a run that produced nothing, and an engine failure, are failed runs with the reason and the usage still reported", async () => {
    await newTask();
    const none = await runJob(await claimOne(), jobOpts(fakeHost(MANIFEST), stubRunner([], { warning: "end node(s) not in the workflow's output: End Flow" })));
    expect(none.outcome).toBe("failed");
    expect(none.error).toBe("produced no output (end node(s) not in the workflow's output: End Flow)");
    const task = await newTask();
    const host = fakeHost(MANIFEST);
    const broken = await runJob(await claimOne(), jobOpts(host, stubRunner([], { ok: false, error: "LocalExecutorError: Failed to start flow", raw: { code: 1, stderr: "Traceback" } })));
    expect(broken.outcome).toBe("failed");
    expect(broken.error).toBe("LocalExecutorError: Failed to start flow");
    expect(broken.usage).toMatchObject({ tool: "griptape-nodes", tokens_in: 0, duration_ms: 1200 });
    expect(host.comments).toHaveLength(0);
    expect((await listEvents(db, { issue: task.issue })).some((e) => e.kind === "run.failed")).toBe(true);
  });
});

describe("nodesComment", () => {
  it("lists the assets with links when the store serves them and names unpriced models", () => {
    const body = nodesComment({
      issue: 7,
      workflow: "w.py",
      assets: [{ id: "A1", title: "T v1", version: 1, kind: "video", mime: "video/mp4", size: 2_500_000, status: "pending", tags: [], url: "https://relay.test/a/A1" }],
      result: { engineVersion: "0.62.2", durationMs: 4000, nodesRun: [{ node: "S", type: "Seedance20VideoGeneration" }], usage: [{ lane: "video", model: "bytedance/seedance-2.0", nodeType: "Seedance20VideoGeneration", outputs: 1, seconds: 8, costEquiv: 0, costKnown: false, durationMs: 4000 }] },
      claim: "c1",
    });
    expect(body).toContain("- [T v1](https://relay.test/a/A1) (video, 2.4 MB, v1, `A1`)");
    expect(body).toContain("Models: video: bytedance/seedance-2.0 x1 (cost unknown).");
    expect(body).toContain('"nodes_run":["Seedance20VideoGeneration"]');
  });
});

describe("the HTTP WorkApi's asset calls", () => {
  it("uploads multipart/form-data with the worker's token and lists an issue's assets", async () => {
    const calls: Array<{ method: string; path: string; contentType: string; body?: string | Uint8Array }> = [];
    const fetchStub: HttpFetch = async (url, init) => {
      const u = new URL(url);
      calls.push({ method: init.method, path: u.pathname + u.search, contentType: init.headers["content-type"] ?? "", ...(init.body !== undefined ? { body: init.body } : {}) });
      const asset = { id: "01HX", project: "prod", issue: 7, title: "Cutscene 7 v1", version: 1, kind: "video", mime: "video/mp4", size: 8, status: "pending", tags: ["prod"], url: "https://relay.test/api/v1/assets/01HX/file" };
      if (u.pathname === "/api/v1/assets" && init.method === "POST") return { ok: true, status: 201, headers: { get: () => "application/json" }, text: async () => JSON.stringify(asset) };
      if (u.pathname === "/api/v1/assets" && init.method === "GET") return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ assets: [asset], count: 1 }) };
      return { ok: false, status: 404, headers: { get: () => "application/json" }, text: async () => "{}" };
    };
    const site = httpWorkApi({ site: "https://relay.test", token: "rly_w", fetch: fetchStub });
    const file = join(tmp, "clip.mp4");
    writeFileSync(file, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const up = await site.uploadAsset({ path: file, project: "prod", issue: 7, title: "Cutscene 7 v1", replaces: "01HW", createdBy: "runner:studio", tags: ["prod", "End Flow"] });
    expect(up).toMatchObject({ id: "01HX", version: 1, kind: "video", url: "https://relay.test/api/v1/assets/01HX/file" });
    const post = calls[0]!;
    expect(post.path).toBe("/api/v1/assets");
    expect(post.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const text = Buffer.from(post.body as Uint8Array).toString("latin1");
    for (const field of ['name="project"\r\n\r\nprod', 'name="issue"\r\n\r\n7', 'name="replaces"\r\n\r\n01HW', 'name="tags"\r\n\r\nprod,End Flow', 'name="file"; filename="clip.mp4"']) expect(text).toContain(field);
    expect(text).toContain("\x00\x00\x00\x18ftyp");
    const list = await site.assetsForIssue("prod", 7);
    expect(calls[1]!.path).toBe("/api/v1/assets?project=prod&issue=7&limit=50");
    expect(list[0]).toMatchObject({ id: "01HX", tags: ["prod"] });
  });

  it("multipart() keeps binary bytes intact and ends with the closing boundary", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x0a, 0x0d, 0x80]);
    const { body, contentType } = multipart({ a: "1" }, { name: "file", filename: 'we"ird\n.bin', bytes });
    const boundary = contentType.split("boundary=")[1]!;
    const s = Buffer.from(body).toString("latin1");
    expect(s.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(s.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(s).toContain('filename="we_ird_.bin"');
    expect(s).toContain("\xff\xd8\x00\x0a\x0d\x80\r\n");
  });
});
