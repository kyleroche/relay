/**
 * fx lane: one `fx ask --json` process per step. Provider (codex | grok | gateway) is chosen by rewriting
 * ~/.fx/settings.json for the duration of the call (fx 0.0.10 has no per-call provider flag; FX_MODEL only
 * picks the model). Calls are serialized per provider, and settings are restored afterwards.
 *
 * Verified 2026-09-23: Codex sub exposes gpt-6-sol/astra/luna, gpt-5.6-*, gpt-5.5; Grok sub runs grok-4.7 once the
 * model is pre-seeded in settings (fx issue #1014 breaks its catalog). A bare call carries ~6-9 K tokens of fx's
 * own context (tool + skill catalog), which the ledger records as-is.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaneRequest, LaneResult, Subscription } from "./types.ts";
import { withSubscriptionLock } from "./types.ts";
import { costEquiv } from "../ledger/ledger.ts";

export type FxProvider = "codex" | "grok" | "gateway";

export interface FxOptions {
  provider: FxProvider;
  model: string; // fx model id, e.g. gpt-6-astra, grok-4.7, or a gateway id like xai/grok-4.7
  bin?: string;
  /** Cap on fx's injected skill catalog; 1 disables it almost entirely. */
  skillCatalogBytes?: number;
}

interface FxAskJson {
  output: string;
  final_output: string;
  exit_code: number;
  model: string;
  session_id: string;
  steps: number;
  tool_calls: unknown[];
  usage: { input_tokens: number | null; output_tokens: number | null };
  error?: string;
}

const FX_HOME = process.env.FX_HOME_DIR ?? join(homedir(), ".fx");
const SETTINGS = join(FX_HOME, "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    return existsSync(SETTINGS) ? (JSON.parse(readFileSync(SETTINGS, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Gateway-style model id for the ledger price table. */
function ledgerModelId(provider: FxProvider, model: string): string {
  if (model.includes("/")) return model;
  if (provider === "codex") return `openai/${model}`;
  if (provider === "grok") return `xai/${model}`;
  return model;
}

export async function runFx(req: LaneRequest, opts: FxOptions): Promise<LaneResult> {
  const bin = opts.bin ?? process.env.RELAY_FX_BIN ?? join(homedir(), ".local", "bin", "fx");
  const subscription: Subscription = opts.provider === "gateway" ? "gateway" : opts.provider;
  const fxProvider = opts.provider === "gateway" ? "vercel" : opts.provider;
  return withSubscriptionLock(`fx:${opts.provider}`, async () => {
    mkdirSync(FX_HOME, { recursive: true });
    const before = readSettings();
    const models = { ...((before["models"] as Record<string, string> | undefined) ?? {}), [fxProvider]: opts.model };
    writeFileSync(SETTINGS, JSON.stringify({ ...before, models, provider: fxProvider }));
    // global launch options come before the subcommand; skill_catalog_bytes trims fx's built-in skill catalog
    // (7.1 K → 4.5 K input tokens on a bare call, measured 2026-09-23). Harness skills arrive via --add-dir.
    const args = ["--context-limit", `skill_catalog_bytes=${opts.skillCatalogBytes ?? 1024}`];
    for (const d of req.addDirs ?? []) args.push("--add-dir", d);
    args.push("ask", "--json", "--no-save", "--quiet");
    if (req.system) args.push("--system", req.system);
    if (!req.readOnly) args.push("--auto");
    args.push("--", req.prompt);
    const t0 = Date.now();
    try {
      const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        const child = execFile(
          bin,
          args,
          { cwd: req.cwd, env: { ...process.env, FX_MODEL: opts.model, FX_NO_OPEN_BROWSER: "1", FX_AUTO_UPGRADE: "0" }, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? 20 * 60_000 },
          (err, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
        );
        child.stdin?.end();
      });
      const durationMs = Date.now() - t0;
      let j: FxAskJson | undefined;
      try {
        j = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "") as FxAskJson;
      } catch {
        /* fall through */
      }
      const model = ledgerModelId(opts.provider, j?.model || opts.model);
      const tokensIn = j?.usage?.input_tokens ?? 0;
      const tokensOut = j?.usage?.output_tokens ?? 0;
      const ok = !!j && j.exit_code === 0 && !j.error && code === 0;
      const res: LaneResult = {
        ok,
        text: j?.final_output || j?.output || "",
        model,
        subscription,
        tokensIn,
        tokensOut,
        cacheRead: 0,
        cacheWrite: 0,
        costEquiv: costEquiv({ lane: req.lane, model, provider: opts.provider, subscription, tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs }),
        durationMs,
        raw: j ?? { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000), code },
      };
      if (j?.session_id) res.sessionId = j.session_id;
      if (!ok) res.error = j?.error ?? (j?.output || stderr || `fx exited ${code}`).slice(0, 500);
      return res;
    } finally {
      writeFileSync(SETTINGS, JSON.stringify(before));
    }
  });
}
