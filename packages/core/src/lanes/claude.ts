/**
 * Claude lane: one `claude -p` process per call, on the Max subscription (official CLI only; the harness never
 * touches the OAuth token). Plan calls use --json-schema for structured output; review calls are read-only.
 * `claude auth status` must report loggedIn=true for the user running the daemon.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneRequest, LaneResult } from "./types.ts";
import { withSubscriptionLock } from "./types.ts";
import { claudeSandboxSettingsJson, looksLikeSandboxUnavailable, parseDomainList, SANDBOX_UNAVAILABLE, type SandboxOptions } from "./sandbox.ts";
import { costEquiv } from "../ledger/ledger.ts";
import { approxTokens } from "../util.ts";

export type ClaudeModel = "fable" | "opus" | "sonnet";
const MODEL_IDS: Record<ClaudeModel, string> = { fable: "anthropic/claude-fable-5-1", opus: "anthropic/claude-opus-5", sonnet: "anthropic/claude-sonnet-5" };

export interface ClaudeOptions {
  model: ClaudeModel;
  bin?: string;
  /** Resume a stuck step. Never used to carry a task forward. */
  resume?: string;
  /**
   * Tool definitions to load (`--tools`). This is the main context lever: [] (no tools) ≈ 11 K tokens of system
   * context, Read/Grep/Glob ≈ 26 K, the default full set ≈ 48 K (measured 2026-09-23 on Sonnet). [] also marks a
   * utility call, which runs in a scratch cwd with no instruction files, memory or skills (≈ 6.8 K, see runClaude).
   * Omit for the default set. `--bare` is not used: it disables the claude.ai login.
   */
  tools?: string[];
  allowedTools?: string[];
  /** `--disallowedTools`: patterns refused even when a broader allow rule would match (the worker passes CODE_DISALLOWED_TOOLS). */
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  /** `--max-turns`: a hard stop for agentic code runs (the worker passes 40). Omit for utility calls. */
  maxTurns?: number;
  /**
   * Claude Code's OS sandbox for Bash and its children (`--settings`, see sandbox.ts): on for `code` requests unless
   * set to false, off for everything else unless set to true or given options. With it on, a run on a machine that
   * cannot sandbox fails (`failIfUnavailable`) and `error` starts with `SANDBOX_UNAVAILABLE`.
   */
  sandbox?: boolean | SandboxOptions;
}

interface ClaudeJson {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  duration_api_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

/** A utility call (digest, summary, capture): no tools, the content is already in the prompt. */
const isUtility = (opts: ClaudeOptions): boolean => opts.tools !== undefined && opts.tools.length === 0;

/** Sandbox options for this call, or undefined when the run is not sandboxed. */
export function sandboxFor(req: LaneRequest, opts: ClaudeOptions): SandboxOptions | undefined {
  const on = opts.sandbox ?? req.lane === "code";
  if (on === false) return undefined;
  const o: SandboxOptions = on === true ? {} : { ...on };
  const extra = parseDomainList((req.env ?? process.env)["RELAY_LANE_ALLOWED_DOMAINS"]);
  if (extra.length) o.allowedDomains = [...(o.allowedDomains ?? []), ...extra];
  return o;
}

/** The argv `claude` is started with. Pure, so tests can snapshot it. */
export function claudeArgs(req: LaneRequest, opts: ClaudeOptions): string[] {
  const utility = isUtility(opts);
  const args = ["-p", "--output-format", "json", "--model", opts.model];
  args.push("--permission-mode", req.readOnly ? "plan" : "acceptEdits");
  if (opts.tools) args.push("--tools", opts.tools.join(","));
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  else if (req.readOnly && opts.tools === undefined) args.push("--allowedTools", "Read,Grep,Glob");
  if (opts.disallowedTools?.length) args.push("--disallowedTools", opts.disallowedTools.join(","));
  // no MCP servers and no user/project settings: those are where plugins and skills inflate the prompt, and where a
  // repository could otherwise loosen the sandbox below
  args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "");
  // the OS sandbox: the only settings document this run sees, so nothing on the machine or in the clone can override it
  const sandbox = sandboxFor(req, opts);
  if (sandbox) args.push("--settings", claudeSandboxSettingsJson(sandbox));
  // Utility calls also drop skills and slash commands and, with the env and scratch cwd set in runClaude, load no
  // project instruction files, auto-memory, hooks or MCP servers, so the model cannot wander off to "check the memory
  // files". Baseline on "Reply with exactly the single word: pong", Sonnet, 2026-10-13, cwd = the relay repo with
  // auto-memory:
  //   before: 11,364 context tokens (2 in + 7,961 cache write + 3,401 cache read), $0.0328 equivalent
  //   after:   6,793 context tokens (2 in + 3,390 cache write + 3,401 cache read), $0.0145 equivalent
  if (utility) args.push("--disable-slash-commands");
  for (const d of req.addDirs ?? []) args.push("--add-dir", d);
  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  args.push("--", req.prompt);
  return args;
}

/**
 * Canned results for `RELAY_FAKE_LANES=1`: no process is spawned and nothing leaves the machine. The shape follows
 * the request's JSON schema (digest batches, the project summary) so the link pipeline can be tested offline.
 */
export function fakeClaude(req: LaneRequest, opts: ClaudeOptions): LaneResult {
  const props = (req.jsonSchema?.properties ?? {}) as Record<string, unknown>;
  let json: unknown;
  let text: string;
  if ("files" in props) {
    const paths = [...req.prompt.matchAll(/^=== FILE: (.+) ===$/gm)].map((m) => m[1]!);
    json = { files: paths.map((path) => ({ path, summary: `Canned digest of ${path}: a file of the test repository, summarized here for the index with enough words to pass validation.` })) };
    text = JSON.stringify(json);
  } else if ("summary" in props) {
    const para = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} of this canned section describes the project in enough detail to count as real text.`).join(" ");
    json = { summary: `## Purpose\n\n${para(4)}\n\n## Stack and layout\n\n${para(5)}\n\n## Commands\n\n${para(3)}\n\n## Conventions\n\n${para(4)}\n\n## Gotchas\n\n${para(3)}\n` };
    text = JSON.stringify(json);
  } else if ("verdict" in props) {
    // the injection gate (tasks/gate.ts): the canned grader clears everything; tests that need a hold inject a grader
    json = { verdict: "clear", score: 0, reasons: [] };
    text = JSON.stringify(json);
  } else text = "pong";
  const model = MODEL_IDS[opts.model];
  const tokensIn = approxTokens(req.prompt + (req.system ?? ""));
  const tokensOut = approxTokens(text);
  const res: LaneResult = {
    ok: true,
    text,
    model,
    subscription: "max",
    tokensIn,
    tokensOut,
    cacheRead: 0,
    cacheWrite: 0,
    costEquiv: costEquiv({ lane: req.lane, model, provider: "anthropic", subscription: "max", tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: 0 }),
    durationMs: 0,
    raw: { fake: true },
  };
  if (json !== undefined) res.json = json;
  return res;
}

export async function runClaude(req: LaneRequest, opts: ClaudeOptions): Promise<LaneResult> {
  if (process.env.RELAY_FAKE_LANES === "1") return fakeClaude(req, opts);
  const bin = opts.bin ?? process.env.RELAY_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
  const model = MODEL_IDS[opts.model];
  const utility = isUtility(opts);
  return withSubscriptionLock("claude:max", async () => {
    const args = claudeArgs(req, opts);
    const t0 = Date.now();
    const env = { ...(req.env ?? process.env) };
    delete env["CLAUDECODE"];
    delete env["CLAUDE_CODE_ENTRYPOINT"];
    // the lane must run on the subscription, never on a stray API key
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    let cwd = req.cwd;
    let scratch: string | undefined;
    if (utility) {
      env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";
      env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "1";
      scratch = mkdtempSync(join(tmpdir(), "relay-lane-"));
      cwd = scratch;
    }
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = execFile(bin, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? 20 * 60_000 }, (err, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
      );
      child.stdin?.end();
    });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    const durationMs = Date.now() - t0;
    let j: ClaudeJson | undefined;
    try {
      j = JSON.parse(stdout.trim()) as ClaudeJson;
    } catch {
      /* fall through */
    }
    const u = j?.usage ?? {};
    const tokensIn = u.input_tokens ?? 0;
    const tokensOut = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const ok = !!j && !j.is_error && code === 0;
    const res: LaneResult = {
      ok,
      text: j?.result ?? "",
      model,
      subscription: "max",
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
      costEquiv: costEquiv({ lane: req.lane, model, provider: "anthropic", subscription: "max", tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead, cache_write: cacheWrite, duration_ms: durationMs }),
      durationMs,
      raw: j ?? { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000), code },
    };
    if (j?.structured_output !== undefined) res.json = j.structured_output;
    if (j?.session_id) res.sessionId = j.session_id;
    if (!ok) {
      const msg = j?.result || stderr || `claude exited ${code}`;
      // failIfUnavailable: Claude Code exited instead of running Bash unsandboxed; name it so the worker can tell the operator
      const unavailable = sandboxFor(req, opts) !== undefined && !j && looksLikeSandboxUnavailable(`${stderr}\n${stdout}`);
      res.error = (unavailable ? `${SANDBOX_UNAVAILABLE}: ${msg}` : msg).slice(0, 500);
    }
    return res;
  });
}
