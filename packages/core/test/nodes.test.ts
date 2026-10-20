/**
 * The nodes lane adapter (lanes/nodes.ts): the shim's stdout contract, the output -> usage mapping, the step.usage
 * rows, the interpreter search, and `runNodes` against a stand-in shim (a Node script in place of the engine's
 * Python). Then the shim itself against the real engine when it is importable here, skipped with the reason otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { listEvents } from "../src/db/events.ts";
import { MEDIA_PRICES, mediaCost } from "../src/ledger/ledger.ts";
import { findNodesPython, interpreterFromLauncher, mediaKindOf, modelForNodeType, NODE_MODELS, nodesUsage, nodesUsageEvents, parseShimStdout, recordNodesUsage, runNodes, type ShimResult } from "../src/lanes/nodes.ts";
import { runtimePaths } from "../src/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "nodes", "echo.py");
const SHIM = runtimePaths().runWorkflowScript;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-nodes-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseShimStdout", () => {
  it("takes the last JSON line and ignores the engine's chatter before it", () => {
    const r = parseShimStdout('Engine started\n{"not": "ours"}\n{"ok": true, "outputs": [], "nodes_run": [{"node": "a", "type": "EndFlow"}], "engine_version": "0.62.2", "seconds": 1.5}\n');
    expect(r?.ok).toBe(true);
    expect(r?.engine_version).toBe("0.62.2");
    expect(r?.nodes_run[0]?.type).toBe("EndFlow");
    expect(parseShimStdout("nothing here")).toBeUndefined();
    expect(parseShimStdout('{"ok": "yes"}')).toBeUndefined();
  });
});

describe("the output -> usage mapping", () => {
  const shim: Pick<ShimResult, "outputs" | "nodes_run"> = {
    outputs: [
      { node: "End Flow", parameter: "video", path: "/x/a.mp4", mime: "video/mp4", bytes: 10, seconds: 8 },
      { node: "End Flow", parameter: "still", path: "/x/b.png", mime: "image/png", bytes: 10 },
      { node: "End Flow", parameter: "still", path: "/x/c.png", mime: "image/png", bytes: 10 },
      { node: "End Flow", parameter: "notes", path: "/x/d.txt", mime: "text/plain", bytes: 10 },
    ],
    nodes_run: [
      { node: "Start Flow", type: "StartFlow" },
      { node: "Seedance", type: "Seedance20VideoGeneration" },
      { node: "Seedream", type: "SeedreamImageGeneration" },
      { node: "End Flow", type: "EndFlow" },
    ],
  };

  it("names the lane by output kind, the model by the node type relay knows, and splits the duration", () => {
    const u = nodesUsage(shim, { durationMs: 10_000 });
    expect(u.map((x) => [x.lane, x.model, x.outputs, x.seconds, x.durationMs])).toEqual([
      ["video", "bytedance/seedance-2.0", 1, 8, 5000],
      ["image", "bytedance/seedream-5", 2, null, 5000],
    ]);
    // the registry does not price media models yet: cost 0, marked unknown, never invented
    expect(u.every((x) => x.costEquiv === 0 && x.costKnown === false)).toBe(true);
    expect(mediaKindOf("text/plain")).toBeUndefined();
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(modelForNodeType("ElevenLabsTextToSpeechGeneration")).toBe("elevenlabs/tts");
    expect(modelForNodeType("SomethingNew")).toBeNull();
    expect(NODE_MODELS.OpenAiImageGeneration?.model).toBe("openai/gpt-image-2");
  });

  it("falls back to the manifest's model when no known node type ran, and prices a model MEDIA_PRICES lists", () => {
    const u = nodesUsage({ outputs: shim.outputs, nodes_run: [{ node: "x", type: "KlingVideo" }] }, { durationMs: 1000, model: "kling/v2" });
    expect(u.map((x) => [x.lane, x.model, x.nodeType])).toEqual([
      ["video", "kling/v2", null],
      ["image", "kling/v2", null],
    ]);
    expect(nodesUsage({ outputs: shim.outputs, nodes_run: [] }, { durationMs: 1000 })[0]?.model).toBeNull();
    MEDIA_PRICES["test/vid"] = { perSecond: 0.1, perOutput: 1 };
    try {
      expect(mediaCost("test/vid", { count: 2, seconds: 8 })).toBeCloseTo(2.8);
      const priced = nodesUsage({ outputs: shim.outputs, nodes_run: [] }, { durationMs: 1000, model: "test/vid" });
      expect(priced[0]).toMatchObject({ lane: "video", costEquiv: 1.8, costKnown: true });
    } finally {
      delete MEDIA_PRICES["test/vid"];
    }
    expect(mediaCost("nobody/prices-this", { count: 1 })).toBeUndefined();
  });

  it("turns the rows into step.usage events, tokens 0, cost_unknown in the payload, and records them", async () => {
    const u = nodesUsage(shim, { durationMs: 2000 });
    const events = nodesUsageEvents(u, { project: "prod", repo: "acme/prod", issue: 7, task: "acme/prod#7", engineVersion: "0.62.2", workflow: "w.py", dedupePrefix: "usage:c1" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "step.usage", actor: "agent:nodes", lane: "video", model: "bytedance/seedance-2.0", tokens_in: 0, tokens_out: 0, cost_equiv: 0, duration_ms: 1000, dedupe_key: "usage:c1:0" });
    expect(events[0]?.payload).toMatchObject({ provider: "griptape-nodes", mode: "nodes", outputs: 1, seconds: 8, cost_unknown: true, node_type: "Seedance20VideoGeneration", engine_version: "0.62.2", workflow: "w.py", task: "acme/prod#7" });
    expect(events[1]?.summary).toBe("image bytedance/seedream-5: 2 outputs (cost unknown)");
    const db: Db = await openDb({ file: ":memory:" });
    try {
      await migrate(db);
      const rows = await recordNodesUsage(db, u, { project: "prod" });
      expect(rows).toHaveLength(2);
      const stored = await listEvents(db, { kind: "step.usage" });
      expect(stored.map((e) => e.lane).sort()).toEqual(["image", "video"]);
    } finally {
      await db.close();
    }
  });
});

describe("the interpreter search", () => {
  it("reads the venv python from a launcher's shebang, prefers RELAY_NODES_PYTHON, and falls back to uv", () => {
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const py = join(tmp, "venv-python3");
    writeFileSync(py, "#!/bin/sh\n");
    chmodSync(py, 0o755);
    const launcher = join(bin, "griptape-nodes");
    writeFileSync(launcher, `#!${py}\n# -*- coding: utf-8 -*-\nimport sys\n`);
    chmodSync(launcher, 0o755);
    expect(interpreterFromLauncher(launcher)).toBe(py);
    expect(findNodesPython({ PATH: bin })).toEqual([py]);
    expect(findNodesPython({ PATH: bin, RELAY_NODES_PYTHON: "/opt/py" })).toEqual(["/opt/py"]);
    const uvdir = join(tmp, "uvbin");
    mkdirSync(uvdir, { recursive: true });
    writeFileSync(join(uvdir, "uv"), "#!/bin/sh\n");
    chmodSync(join(uvdir, "uv"), 0o755);
    expect(findNodesPython({ PATH: uvdir })).toEqual([join(uvdir, "uv"), "tool", "run", "--from", "griptape-nodes", "python"]);
    expect(findNodesPython({ PATH: join(tmp, "nowhere") })).toBeUndefined();
  });
});

describe("runNodes against a stand-in shim", () => {
  /** A Node script that behaves like run_workflow.py: reads the arguments, writes files into --out, prints the document last. */
  function fakeShim(name: string, body: string): string {
    const p = join(tmp, `${name}.mjs`);
    writeFileSync(p, `import { writeFileSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nconst a = process.argv.slice(2);\nconst arg = (k) => a[a.indexOf(k) + 1];\nconst out = arg("--out"); const inputs = JSON.parse(readFileSync(arg("--inputs"), "utf8")); const outputs = a.includes("--outputs") ? arg("--outputs") : "";\n${body}\n`);
    return p;
  }

  it("passes the workflow, inputs and outputs through, keeps only outputs whose files exist, and maps the usage", async () => {
    const script = fakeShim(
      "ok",
      `console.log("engine noise");\nwriteFileSync(join(out, "End_Flow-video.mp4"), "mp4"); writeFileSync(join(out, "End_Flow-greeting.txt"), inputs["Start Flow"].topic);\nconsole.log(JSON.stringify({ ok: true, outputs: [{ node: "End Flow", parameter: "video", path: join(out, "End_Flow-video.mp4"), mime: "video/mp4", bytes: 3, seconds: 5 }, { node: "End Flow", parameter: "greeting", path: join(out, "End_Flow-greeting.txt"), mime: "text/plain", bytes: 5 }, { node: "End Flow", parameter: "gone", path: join(out, "missing.png"), mime: "image/png", bytes: 1 }], nodes_run: [{ node: "V", type: "Seedance20VideoGeneration" }], engine_version: "0.62.2", seconds: 0.2, libraries: ["Griptape Nodes Library"], workflow_name: "wf", outputs_arg: outputs }));`,
    );
    const outDir = join(tmp, "out-ok");
    const r = await runNodes({ workflow: FIXTURE, inputs: { "Start Flow": { topic: "hello" } }, outputs: ["End Flow"], outDir, python: [process.execPath], script, timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.engineVersion).toBe("0.62.2");
    expect(r.workflowName).toBe("wf");
    expect(r.libraries).toEqual(["Griptape Nodes Library"]);
    expect(r.outputs.map((o) => o.parameter)).toEqual(["video", "greeting"]);
    expect(readFileSync(join(outDir, "End_Flow-greeting.txt"), "utf8")).toBe("hello");
    expect(JSON.parse(readFileSync(join(outDir, ".inputs.json"), "utf8"))).toEqual({ "Start Flow": { topic: "hello" } });
    expect(r.usage).toEqual([{ lane: "video", model: "bytedance/seedance-2.0", nodeType: "Seedance20VideoGeneration", outputs: 1, seconds: 5, costEquiv: 0, costKnown: false, durationMs: r.durationMs }]);
    expect(r.interpreter).toEqual([process.execPath]);
  });

  it("an engine failure is ok: false with the shim's error, never a throw", async () => {
    const script = fakeShim("fail", `console.error("Traceback..."); console.log(JSON.stringify({ ok: false, outputs: [], nodes_run: [], engine_version: "0.62.2", seconds: 0.1, error: "LocalExecutorError: Failed to start flow" })); process.exit(1);`);
    const r = await runNodes({ workflow: FIXTURE, inputs: {}, outDir: join(tmp, "out-fail"), python: [process.execPath], script, timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("LocalExecutorError: Failed to start flow");
    expect(r.raw?.code).toBe(1);
    expect(r.raw?.stderr).toContain("Traceback");
  });

  it("a shim that prints nothing, a missing workflow and a missing interpreter are named failures", async () => {
    const script = fakeShim("silent", `console.error("died"); process.exit(2);`);
    const r = await runNodes({ workflow: FIXTURE, inputs: {}, outDir: join(tmp, "out-silent"), python: [process.execPath], script, timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/printed no result \(exit 2\): died/);
    const missing = await runNodes({ workflow: join(tmp, "nope.py"), inputs: {}, outDir: join(tmp, "out-x"), python: [process.execPath], script, timeoutMs: 30_000 });
    expect(missing.error).toMatch(/workflow file not found/);
    const noPy = await runNodes({ workflow: FIXTURE, inputs: {}, outDir: join(tmp, "out-y"), env: { PATH: join(tmp, "nowhere") }, script, timeoutMs: 30_000 });
    expect(noPy.error).toMatch(/griptape-nodes is not installed/);
  });

  it("a run past the time limit is reported as such", async () => {
    const script = fakeShim("slow", `setTimeout(() => console.log(JSON.stringify({ ok: true, outputs: [], nodes_run: [], engine_version: "x", seconds: 9 })), 5000);`);
    const r = await runNodes({ workflow: FIXTURE, inputs: {}, outDir: join(tmp, "out-slow"), python: [process.execPath], script, timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not finish within/);
  });
});

// ---------- the real engine, when it is here ----------

const enginePython = (() => {
  const py = findNodesPython(process.env);
  if (!py || py.length !== 1) return undefined;
  try {
    execFileSync(py[0]!, ["-c", "import griptape_nodes, griptape.artifacts"], { stdio: "ignore", timeout: 60_000 });
    return py[0];
  } catch {
    return undefined;
  }
})();
const engineHere = !!enginePython;
const skipReason = engineHere ? "" : "Griptape Nodes is not importable on this machine (no `griptape-nodes` uv tool on PATH); the shim's contract is checked by the stand-in above";

describe.skipIf(!engineHere)(`the shim under the real engine${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  it("materialize() turns artifacts into files: bytes, a downloaded URL, a list, text only for listed nodes", () => {
    const out = join(tmp, "materialize");
    mkdirSync(out, { recursive: true });
    const src = join(tmp, "src.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const code = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(dirname(SHIM))})`,
      "import run_workflow as rw",
      "from pathlib import Path",
      "from griptape.artifacts import ImageArtifact, ImageUrlArtifact, ListArtifact, TextArtifact, JsonArtifact",
      "img = ImageArtifact(b'\\x89PNGbytes', format='png', width=1, height=1)",
      `url = ImageUrlArtifact(${JSON.stringify(`file://${src}`)})`,
      "lst = ListArtifact([TextArtifact('a'), ImageArtifact(b'JPG', format='jpeg', width=1, height=1)])",
      "output = {'End Flow': {'exec_in': None, 'was_successful': True, 'image': img, 'ref': url, 'many': lst, 'note': TextArtifact('hello'), 'meta': JsonArtifact({'k': 1}), 'plain': 'text value', 'num': 3}, 'Other': {'note': TextArtifact('skipped'), 'img': img}}",
      `res = rw.materialize(output, Path(${JSON.stringify(out)}), ['End Flow'])`,
      "print(json.dumps(res))",
    ].join("\n");
    const res = JSON.parse(execFileSync(enginePython!, ["-c", code], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim().split("\n").pop()!) as Array<{ node: string; parameter: string; path: string; mime: string; bytes: number }>;
    const byParam = Object.fromEntries(res.map((r) => [`${r.parameter}${r.path.includes("-2.") || /-\d\./.test(r.path) ? "" : ""}`, r]));
    expect(res.every((r) => r.node === "End Flow")).toBe(true);
    expect(byParam.image).toMatchObject({ mime: "image/png", bytes: 9 });
    expect(byParam.image!.path.endsWith("End_Flow-image.png")).toBe(true);
    expect(byParam.ref).toMatchObject({ mime: "image/png", bytes: 7 });
    expect(readFileSync(byParam.ref!.path)).toEqual(readFileSync(src));
    const many = res.filter((r) => r.parameter === "many");
    expect(many.map((r) => r.mime)).toEqual(["text/plain", "image/jpeg"]);
    expect(many[1]!.path.endsWith("End_Flow-many-2.jpeg")).toBe(true);
    expect(readFileSync(byParam.note!.path, "utf8")).toBe("hello");
    expect(byParam.meta!.mime).toBe("application/json");
    expect(readFileSync(byParam.plain!.path, "utf8")).toBe("text value");
    expect(byParam.num!.mime).toBe("application/json");
    // nothing from the unlisted node, nothing for the control/status parameters
    expect(res.some((r) => r.node === "Other")).toBe(false);
    expect(res.some((r) => r.parameter === "was_successful" || r.parameter === "exec_in")).toBe(false);
  });

  it("runs the fixture workflow headless: the start node's topic comes back as End Flow's greeting, as one JSON document on stdout", () => {
    const out = join(tmp, "engine-out");
    const inputs = join(tmp, "engine-inputs.json");
    writeFileSync(inputs, JSON.stringify({ "Start Flow": { topic: "hello relay" } }));
    let stdout = "";
    try {
      // the engine prints large tables on stderr; the adapter allows 64 MB for the same reason
      stdout = execFileSync(enginePython!, [SHIM, "--workflow", FIXTURE, "--inputs", inputs, "--out", out, "--outputs", "End Flow"], { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], cwd: tmp, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      stdout = String((e as { stdout?: string }).stdout ?? "");
    }
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1); // the engine's own output went to stderr
    const r = parseShimStdout(stdout)!;
    expect(r).toBeDefined();
    expect(r.ok, r.error).toBe(true);
    expect(r.engine_version).toMatch(/^\d+\.\d+/);
    expect(r.workflow_name).toBe("relay-echo");
    expect(r.nodes_run.map((n) => n.type).sort()).toEqual(["EndFlow", "StartFlow"]);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]).toMatchObject({ node: "End Flow", parameter: "greeting", mime: "text/plain", bytes: 11 });
    expect(readFileSync(r.outputs[0]!.path, "utf8")).toBe("hello relay");
    expect(existsSync(resolve(out, "End_Flow-greeting.txt"))).toBe(true);
  }, 300_000);
});
