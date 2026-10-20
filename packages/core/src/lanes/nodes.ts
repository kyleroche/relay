/**
 * The nodes lane: one Griptape Nodes workflow run headless, out of process, under the engine's own interpreter.
 *
 * The adapter starts `run_workflow.py` (packages/cli/python, shipped as dist/python; `runtimePaths().runWorkflowScript`)
 * with the workflow file, the inputs as a JSON file and an output directory, waits with a timeout, and reads the one
 * JSON document the shim prints last on stdout. The interpreter is found, never assumed: `RELAY_NODES_PYTHON`, else
 * the shebang of the `griptape-nodes` launcher on PATH (a uv tool venv), else `uv tool run --from griptape-nodes python`.
 *
 * The engine calls the vendors (ByteDance, OpenAI, Google, ElevenLabs...) with the keys in that machine's environment,
 * so a run is paid use, not subscription use: the usage rows are one `step.usage` per output model, on lane `video`,
 * `image` or `audio` by what came out, tokens 0, the cost from `ledger/ledger.ts`'s MEDIA_PRICES when the model is
 * priced and `cost_unknown: true` otherwise. Model ids come from the node types the workflow ran (NODE_MODELS), then
 * from the manifest's `model`, else null.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { delimiter } from "node:path";
import { statSync } from "node:fs";
import type { Db } from "../db/client.ts";
import { writeEvent, type EventInput, type EventRow } from "../db/events.ts";
import { mediaCost } from "../ledger/ledger.ts";
import { runtimePaths } from "../runtime.ts";
import type { LaneName } from "./types.ts";

export type MediaKind = "video" | "image" | "audio";

/**
 * Node types the engine's libraries expose, and the model id relay records for each. The ids are the ones
 * `onboard/registry.ts` names where it has the model, gateway-style `provider/model` otherwise.
 */
export const NODE_MODELS: Record<string, { model: string; kind: MediaKind }> = {
  Seedance20VideoGeneration: { model: "bytedance/seedance-2.0", kind: "video" },
  SeedanceVideoGeneration: { model: "bytedance/seedance-2.5", kind: "video" },
  SeedreamImageGeneration: { model: "bytedance/seedream-5", kind: "image" },
  OpenAiImageGeneration: { model: "openai/gpt-image-2", kind: "image" },
  GeminiImageGenerator: { model: "google/gemini-image", kind: "image" },
  GeminiImageGeneration: { model: "google/gemini-image", kind: "image" },
  ElevenLabsSpeech: { model: "elevenlabs/tts", kind: "audio" },
  ElevenLabsTextToSpeechGeneration: { model: "elevenlabs/tts", kind: "audio" },
  ElevenLabsMusicGeneration: { model: "elevenlabs/music", kind: "audio" },
};

/** The model for a node type, or null when relay does not know it. */
export const modelForNodeType = (nodeType: string): string | null => NODE_MODELS[nodeType]?.model ?? null;

export interface NodesOutput {
  node: string;
  parameter: string;
  /** Absolute path of the file the shim wrote. */
  path: string;
  mime: string;
  bytes: number;
  seconds?: number;
  provider_job_id?: string;
  source_url?: string;
}

export interface NodesNodeRun {
  node: string;
  type: string;
  library?: string | null;
}

/** What the shim prints: one JSON document, the last line of stdout. */
export interface ShimResult {
  ok: boolean;
  outputs: NodesOutput[];
  nodes_run: NodesNodeRun[];
  engine_version: string;
  seconds: number;
  error?: string;
  warning?: string;
  libraries?: string[];
  workflow_name?: string;
}

export interface NodesRequest {
  /** Absolute path of the workflow file. */
  workflow: string;
  inputs: Record<string, Record<string, unknown>>;
  /** End nodes to keep; every end node when omitted. */
  outputs?: string[];
  /** Where the shim writes the output files (created). */
  outDir: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Interpreter override (tests, `RELAY_NODES_PYTHON`). */
  python?: string[];
  /** Shim override. */
  script?: string;
  /** The manifest's model, used for outputs whose node type relay does not know. */
  model?: string;
  project?: string;
  task?: string;
}

/** One `step.usage` row to be: the outputs of one model of one kind. */
export interface NodesUsage {
  lane: MediaKind;
  model: string | null;
  nodeType: string | null;
  outputs: number;
  seconds: number | null;
  costEquiv: number;
  costKnown: boolean;
  durationMs: number;
}

export interface NodesResult {
  ok: boolean;
  outputs: NodesOutput[];
  nodesRun: NodesNodeRun[];
  libraries: string[];
  engineVersion: string;
  workflowName?: string;
  durationMs: number;
  usage: NodesUsage[];
  /** The interpreter argv that ran the shim. */
  interpreter: string[];
  error?: string;
  warning?: string;
  /** stderr tail and exit code, for the log. */
  raw?: { code: number; stderr: string; stdout?: string };
}

export const DEFAULT_NODES_TIMEOUT_MS = 60 * 60_000;

function onPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** The interpreter behind a launcher script: its `#!` line when it names a python, else undefined. */
export function interpreterFromLauncher(launcher: string): string | undefined {
  try {
    const head = readFileSync(launcher, { encoding: "utf8", flag: "r" }).slice(0, 400);
    const m = /^#!\s*(\S*python[\w.]*)\s*$/m.exec(head.split("\n")[0] ?? "");
    return m && existsSync(m[1]!) ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The argv that runs Python with the engine importable, in order of preference: `RELAY_NODES_PYTHON` (a path),
 * the interpreter named by the shebang of `griptape-nodes` on PATH (the uv tool venv, so nothing is hardcoded about
 * where the user installed it), `uv tool run --from griptape-nodes python`. Undefined when none applies.
 */
export function findNodesPython(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if (env.RELAY_NODES_PYTHON) return [env.RELAY_NODES_PYTHON];
  const launcher = onPath("griptape-nodes", env) ?? onPath("gtn", env);
  if (launcher) {
    const py = interpreterFromLauncher(launcher);
    if (py) return [py];
    // a launcher that is not a venv script: its own directory may hold the venv's python
    for (const name of ["python3", "python"]) {
      const p = join(dirname(launcher), name);
      if (existsSync(p)) return [p];
    }
  }
  const uv = onPath("uv", env);
  if (uv) return [uv, "tool", "run", "--from", "griptape-nodes", "python"];
  return undefined;
}

/** `video` | `image` | `audio` from a mime type, or undefined for anything else (text, json, files). */
export function mediaKindOf(mime: string): MediaKind | undefined {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("audio/")) return "audio";
  return undefined;
}

/**
 * The usage rows a shim result earns: one per (kind, model). The model for a kind is the first node type of that
 * kind the workflow ran that relay knows; otherwise the manifest's model; otherwise null. The run's wall time is
 * split evenly over the rows so the ledger's duration sum stays the run's duration.
 */
export function nodesUsage(r: Pick<ShimResult, "outputs" | "nodes_run">, opts: { durationMs: number; model?: string | undefined }): NodesUsage[] {
  const byKind = new Map<MediaKind, NodesOutput[]>();
  for (const o of r.outputs ?? []) {
    const kind = mediaKindOf(o.mime ?? "");
    if (!kind) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), o]);
  }
  const rows: NodesUsage[] = [];
  const share = byKind.size ? Math.round(opts.durationMs / byKind.size) : opts.durationMs;
  for (const [kind, outs] of byKind) {
    const ran = (r.nodes_run ?? []).find((n) => NODE_MODELS[n.type]?.kind === kind);
    const model = ran ? NODE_MODELS[ran.type]!.model : (opts.model ?? null);
    const seconds = outs.some((o) => typeof o.seconds === "number") ? outs.reduce((s, o) => s + (o.seconds ?? 0), 0) : null;
    const cost = mediaCost(model, { count: outs.length, seconds });
    rows.push({ lane: kind, model, nodeType: ran?.type ?? null, outputs: outs.length, seconds, costEquiv: cost ?? 0, costKnown: cost !== undefined, durationMs: share });
  }
  return rows;
}

/** The last line of stdout that parses as the shim's document. */
export function parseShimStdout(stdout: string): ShimResult | undefined {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as Partial<ShimResult>;
      if (typeof j.ok === "boolean" && Array.isArray(j.outputs)) return { nodes_run: [], engine_version: "unknown", seconds: 0, ...j } as ShimResult;
    } catch {
      /* not ours */
    }
  }
  return undefined;
}

/** Run the shim; never throws for an engine failure (that is `ok: false` with `error`). */
export async function runNodes(req: NodesRequest): Promise<NodesResult> {
  const env = req.env ?? process.env;
  const interpreter = req.python ?? findNodesPython(env);
  const script = req.script ?? runtimePaths().runWorkflowScript;
  const t0 = Date.now();
  const fail = (error: string, raw?: NodesResult["raw"]): NodesResult => ({ ok: false, outputs: [], nodesRun: [], libraries: [], engineVersion: "unknown", durationMs: Date.now() - t0, usage: [], interpreter: interpreter ?? [], error, ...(raw ? { raw } : {}) });
  if (!interpreter) return fail("griptape-nodes is not installed on this machine (no `griptape-nodes` launcher or `uv` on PATH, and RELAY_NODES_PYTHON is unset); install it from https://docs.griptapenodes.com");
  if (!existsSync(script)) return fail(`the nodes shim is missing: ${script}`);
  if (!existsSync(req.workflow)) return fail(`workflow file not found: ${req.workflow}`);
  mkdirSync(req.outDir, { recursive: true });
  const inputsFile = join(req.outDir, ".inputs.json");
  writeFileSync(inputsFile, JSON.stringify(req.inputs ?? {}));
  const args = [...interpreter.slice(1), script, "--workflow", req.workflow, "--inputs", inputsFile, "--out", req.outDir];
  if (req.outputs?.length) args.push("--outputs", req.outputs.join(","));
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile(
      interpreter[0]!,
      args,
      { cwd: req.cwd ?? dirname(req.workflow), env: { ...env, PYTHONUNBUFFERED: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? DEFAULT_NODES_TIMEOUT_MS, killSignal: "SIGTERM" },
      (err, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
  const durationMs = Date.now() - t0;
  const raw = { code, stderr: stderr.slice(-4000), ...(code !== 0 ? { stdout: stdout.slice(-2000) } : {}) };
  const j = parseShimStdout(stdout);
  if (!j) {
    const timedOut = req.timeoutMs !== undefined && durationMs >= req.timeoutMs;
    return fail(timedOut ? `the workflow did not finish within ${Math.round((req.timeoutMs ?? 0) / 60_000)} min` : `the nodes shim printed no result (exit ${code}): ${(stderr.trim().split("\n").pop() ?? "").slice(0, 300)}`, raw);
  }
  const outputs = (j.outputs ?? []).filter((o) => o && typeof o.path === "string" && existsSync(o.path));
  const res: NodesResult = {
    ok: j.ok && code === 0,
    outputs,
    nodesRun: j.nodes_run ?? [],
    libraries: j.libraries ?? [],
    engineVersion: j.engine_version ?? "unknown",
    durationMs,
    usage: nodesUsage({ outputs, nodes_run: j.nodes_run ?? [] }, { durationMs, model: req.model }),
    interpreter,
    raw,
  };
  if (j.workflow_name) res.workflowName = j.workflow_name;
  if (j.warning) res.warning = j.warning;
  if (!res.ok) res.error = (j.error ?? `the nodes shim exited ${code}`).slice(0, 500);
  return res;
}

export interface NodesUsageContext {
  actor?: string;
  project?: string | null;
  repo?: string | null;
  issue?: number | null;
  task?: string;
  url?: string | null;
  engineVersion?: string;
  workflow?: string;
  /** Idempotency prefix; each row gets `:<n>` appended. */
  dedupePrefix?: string;
  extraPayload?: Record<string, unknown>;
}

/** The `step.usage` rows for a result, as event inputs: the same shape whether the worker reports them or the CLI writes them. */
export function nodesUsageEvents(usage: NodesUsage[], ctx: NodesUsageContext): EventInput[] {
  return usage.map((u, i) => {
    const payload: Record<string, unknown> = { provider: "griptape-nodes", tool: "griptape-nodes", mode: "nodes", outputs: u.outputs, cost_unknown: !u.costKnown, ...(ctx.extraPayload ?? {}) };
    if (u.nodeType) payload.node_type = u.nodeType;
    if (u.seconds !== null) payload.seconds = u.seconds;
    if (ctx.engineVersion) payload.engine_version = ctx.engineVersion;
    if (ctx.workflow) payload.workflow = ctx.workflow;
    if (ctx.task) payload.task = ctx.task;
    const e: EventInput = {
      kind: "step.usage",
      actor: ctx.actor ?? "agent:nodes",
      project: ctx.project ?? null,
      repo: ctx.repo ?? null,
      issue: ctx.issue ?? null,
      lane: u.lane satisfies LaneName,
      model: u.model,
      subscription: null,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      cost_equiv: u.costEquiv,
      duration_ms: u.durationMs,
      summary: `${u.lane} ${u.model ?? "unknown model"}: ${u.outputs} output${u.outputs === 1 ? "" : "s"}${u.seconds !== null ? `, ${u.seconds}s` : ""}${u.costKnown ? "" : " (cost unknown)"}`,
      url: ctx.url ?? null,
      payload,
    };
    if (ctx.dedupePrefix) e.dedupe_key = `${ctx.dedupePrefix}:${i}`;
    return e;
  });
}

/** Write the rows to a database (the local CLI path; a worker reports them through `release` instead). */
export async function recordNodesUsage(db: Db, usage: NodesUsage[], ctx: NodesUsageContext): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (const e of nodesUsageEvents(usage, ctx)) {
    const r = await writeEvent(db, e);
    if (r) rows.push(r);
  }
  return rows;
}
