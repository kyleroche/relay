/**
 * Claude lane: one `claude -p` process per call, on the Max subscription (official CLI only; the harness never
 * touches the OAuth token). Plan calls use --json-schema for structured output; review calls are read-only.
 * `claude auth status` must report loggedIn=true for the user running the daemon.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaneRequest, LaneResult } from "./types.ts";
import { withSubscriptionLock } from "./types.ts";
import { costEquiv } from "../ledger/ledger.ts";

export type ClaudeModel = "fable" | "opus" | "sonnet";
const MODEL_IDS: Record<ClaudeModel, string> = { fable: "anthropic/claude-fable-5-1", opus: "anthropic/claude-opus-5", sonnet: "anthropic/claude-sonnet-5" };

export interface ClaudeOptions {
  model: ClaudeModel;
  bin?: string;
  /** Resume a stuck step. Never used to carry a task forward. */
  resume?: string;
  /**
   * Tool definitions to load (`--tools`). This is the main context lever: [] (no tools) ≈ 11 K tokens of system
   * context, Read/Grep/Glob ≈ 26 K, the default full set ≈ 48 K (measured 2026-09-23 on Sonnet).
   * Omit for the default set. `--bare` is not used: it disables the claude.ai login.
   */
  tools?: string[];
  allowedTools?: string[];
  maxBudgetUsd?: number;
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

export async function runClaude(req: LaneRequest, opts: ClaudeOptions): Promise<LaneResult> {
  const bin = opts.bin ?? process.env.RELAY_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
  const model = MODEL_IDS[opts.model];
  return withSubscriptionLock("claude:max", async () => {
    const args = ["-p", "--output-format", "json", "--model", opts.model];
    args.push("--permission-mode", req.readOnly ? "plan" : "acceptEdits");
    if (opts.tools) args.push("--tools", opts.tools.join(","));
    if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
    else if (req.readOnly && opts.tools === undefined) args.push("--allowedTools", "Read,Grep,Glob");
    // no MCP servers and no user/project settings: those are where plugins and skills inflate the prompt
    args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "");
    for (const d of req.addDirs ?? []) args.push("--add-dir", d);
    if (req.system) args.push("--append-system-prompt", req.system);
    if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
    if (opts.resume) args.push("--resume", opts.resume);
    if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    args.push("--", req.prompt);
    const t0 = Date.now();
    const env = { ...process.env };
    delete env["CLAUDECODE"];
    delete env["CLAUDE_CODE_ENTRYPOINT"];
    // the lane must run on the subscription, never on a stray API key
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = execFile(bin, args, { cwd: req.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? 20 * 60_000 }, (err, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
      );
      child.stdin?.end();
    });
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
    if (!ok) res.error = (j?.result || stderr || `claude exited ${code}`).slice(0, 500);
    return res;
  });
}
