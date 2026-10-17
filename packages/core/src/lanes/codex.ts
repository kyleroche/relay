/**
 * Codex lane over the native CLI: one `codex exec --json` process per call on the machine's own ChatGPT login
 * (`codex login`). Mirrors the flags scripts/runner/run-lane.sh used: `--sandbox workspace-write` (read-only for
 * review calls), `-c agents.enabled=false` so no subagents inflate the run, `-m <model>` when asked. Output is
 * JSONL; usage arrives in `turn.completed` events and the final text in the last `agent_message` item.
 */
import { execFile } from "node:child_process";
import type { LaneRequest, LaneResult } from "./types.ts";
import { withSubscriptionLock } from "./types.ts";
import { costEquiv } from "../ledger/ledger.ts";
import { approxTokens } from "../util.ts";
import { findOnPath } from "../github/client.ts";

export interface CodexOptions {
  /** Codex model id (`gpt-5.5`, `gpt-6-astra`, ...). Omit for the CLI's default. */
  model?: string;
  bin?: string;
}

interface CodexLine {
  type?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  item?: { type?: string; text?: string };
  error?: { message?: string };
  message?: string;
}

export function fakeCodex(req: LaneRequest, opts: CodexOptions): LaneResult {
  const text = "pong";
  const model = `openai/${opts.model ?? "codex"}`;
  const tokensIn = approxTokens(req.prompt + (req.system ?? ""));
  const tokensOut = approxTokens(text);
  return { ok: true, text, model, subscription: "codex", tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, costEquiv: costEquiv({ lane: req.lane, model, provider: "codex", subscription: "codex", tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: 0 }), durationMs: 0, raw: { fake: true } };
}

/** Parse `codex exec --json` output: summed usage over turns, the last agent message as text. */
export function parseCodexJsonl(stdout: string): { tokensIn: number; tokensOut: number; cacheRead: number; text: string; turns: number; error?: string } {
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let turns = 0;
  let text = "";
  let error: string | undefined;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let j: CodexLine;
    try {
      j = JSON.parse(t) as CodexLine;
    } catch {
      continue;
    }
    if (j.type === "turn.completed") {
      turns++;
      tokensIn += j.usage?.input_tokens ?? 0;
      tokensOut += j.usage?.output_tokens ?? 0;
      cacheRead += j.usage?.cached_input_tokens ?? 0;
    } else if (j.type === "item.completed" && j.item?.type === "agent_message" && typeof j.item.text === "string") text = j.item.text;
    else if (j.type === "error" || j.type === "turn.failed") error = j.error?.message ?? j.message ?? "codex reported an error";
  }
  return { tokensIn, tokensOut, cacheRead, text, turns, ...(error ? { error } : {}) };
}

export async function runCodex(req: LaneRequest, opts: CodexOptions = {}): Promise<LaneResult> {
  if (process.env.RELAY_FAKE_LANES === "1") return fakeCodex(req, opts);
  const bin = opts.bin ?? process.env.RELAY_CODEX_BIN ?? findOnPath("codex") ?? "codex";
  return withSubscriptionLock("codex", async () => {
    const args = ["exec", "--json", "--sandbox", req.readOnly ? "read-only" : "workspace-write", "-c", "agents.enabled=false"];
    if (opts.model) args.push("-m", opts.model);
    args.push(req.prompt);
    const env = { ...process.env };
    delete env["OPENAI_API_KEY"]; // the lane runs on the subscription, never on a stray key
    const t0 = Date.now();
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = execFile(bin, args, { cwd: req.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? 20 * 60_000 }, (err, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
      );
      child.stdin?.end();
    });
    const durationMs = Date.now() - t0;
    const p = parseCodexJsonl(stdout);
    const model = `openai/${opts.model ?? "codex"}`;
    const ok = p.turns > 0 && !p.error && code === 0;
    const res: LaneResult = {
      ok,
      text: p.text,
      model,
      subscription: "codex",
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      cacheRead: p.cacheRead,
      cacheWrite: 0,
      costEquiv: costEquiv({ lane: req.lane, model, provider: "codex", subscription: "codex", tokens_in: p.tokensIn, tokens_out: p.tokensOut, cache_read: p.cacheRead, duration_ms: durationMs }),
      durationMs,
      raw: { turns: p.turns, code, stderr: stderr.slice(0, 2000) },
    };
    if (!ok) res.error = (p.error ?? stderr ?? `codex exited ${code}`).slice(0, 500);
    return res;
  });
}
