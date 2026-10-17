/**
 * Grok lane over the native Grok Build CLI: one `grok -p` process per call on the machine's own login (`grok login`).
 * Mirrors scripts/runner/run-lane.sh: JSON output, `--no-subagents --no-plan`, `--permission-mode acceptEdits`
 * (`plan` for read-only calls), `-m <model>` when asked. Never a bypass flag.
 */
import { execFile } from "node:child_process";
import type { LaneRequest, LaneResult } from "./types.ts";
import { withSubscriptionLock } from "./types.ts";
import { costEquiv } from "../ledger/ledger.ts";
import { approxTokens } from "../util.ts";
import { findOnPath } from "../github/client.ts";

export interface GrokOptions {
  /** Grok model id (`grok-4.7`, ...). Omit for the CLI's default. */
  model?: string;
  bin?: string;
}

interface GrokJson {
  is_error?: boolean;
  result?: string;
  text?: string;
  output?: string;
  model?: string;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cached_input_tokens?: number; cache_creation_input_tokens?: number };
}

export function fakeGrok(req: LaneRequest, opts: GrokOptions): LaneResult {
  const text = "pong";
  const model = `xai/${opts.model ?? "grok"}`;
  const tokensIn = approxTokens(req.prompt + (req.system ?? ""));
  const tokensOut = approxTokens(text);
  return { ok: true, text, model, subscription: "grok", tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, costEquiv: costEquiv({ lane: req.lane, model, provider: "grok", subscription: "grok", tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: 0 }), durationMs: 0, raw: { fake: true } };
}

export async function runGrok(req: LaneRequest, opts: GrokOptions = {}): Promise<LaneResult> {
  if (process.env.RELAY_FAKE_LANES === "1") return fakeGrok(req, opts);
  const bin = opts.bin ?? process.env.RELAY_GROK_BIN ?? findOnPath("grok") ?? "grok";
  return withSubscriptionLock("grok", async () => {
    const args = ["-p", req.prompt, "--output-format", "json", "--no-subagents", "--no-plan", "--permission-mode", req.readOnly ? "plan" : "acceptEdits"];
    if (opts.model) args.push("-m", opts.model);
    const env = { ...(req.env ?? process.env) };
    delete env["XAI_API_KEY"];
    const t0 = Date.now();
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = execFile(bin, args, { cwd: req.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? 20 * 60_000 }, (err, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
      );
      child.stdin?.end();
    });
    let durationMs = Date.now() - t0;
    let j: GrokJson | undefined;
    try {
      j = JSON.parse(stdout.trim()) as GrokJson;
    } catch {
      /* fall through */
    }
    if (j?.duration_ms && j.duration_ms > 0) durationMs = j.duration_ms;
    const u = j?.usage ?? {};
    const tokensIn = u.input_tokens ?? 0;
    const tokensOut = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const model = `xai/${j?.model || opts.model || "grok"}`;
    const ok = !!j && !j.is_error && code === 0;
    const res: LaneResult = {
      ok,
      text: j?.result ?? j?.text ?? j?.output ?? "",
      model,
      subscription: "grok",
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
      costEquiv: costEquiv({ lane: req.lane, model, provider: "grok", subscription: "grok", tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead, cache_write: cacheWrite, duration_ms: durationMs }),
      durationMs,
      raw: j ?? { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000), code },
    };
    if (!ok) res.error = (j?.result || stderr || `grok exited ${code}`).slice(0, 500);
    return res;
  });
}
