/**
 * fx lane: one `fx ask --json` process per step. Provider (codex | grok | gateway) is chosen by rewriting
 * ~/.fx/settings.json for the duration of the call (fx 0.0.10 has no per-call provider flag; FX_MODEL only
 * picks the model). Calls are serialized per provider, and settings are restored afterwards.
 *
 * The model is the caller's when given (`RELAY_MODEL_<LANE>`); otherwise the login's: fx's own default for the
 * provider (`models.<provider>` in its settings), else the first id `fx models --json` lists, else `FX_FALLBACK_MODEL`.
 * A model the subscription refuses (`model_not_found`: the catalog moves, 2026-11-03 the Codex sub dropped gpt-5.5
 * for gpt-6.1-sol/terra, gpt-6-astra/sol/luna and gpt-5.6-*) is retried once with the catalog's first model. Grok
 * runs grok-4.7 once the model is pre-seeded in settings (fx issue #1014 breaks its catalog). A bare call carries
 * ~6-9 K tokens of fx's own context (tool + skill catalog), which the ledger records as-is.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaneRequest, LaneResult, Subscription } from "./types.ts";
import { withSubscriptionLock } from "./types.ts";
import { cliBin } from "./bin.ts";
import { costEquiv } from "../ledger/ledger.ts";

export type FxProvider = "codex" | "grok" | "gateway";

export interface FxOptions {
  provider: FxProvider;
  /** fx model id (gpt-6-astra, grok-4.7, a gateway id like xai/grok-4.7). Omit for the login's own: `pickFxModel`. */
  model?: string;
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

const fxHome = (): string => process.env.FX_HOME_DIR ?? join(homedir(), ".fx");
const settingsPath = (): string => join(fxHome(), "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    return existsSync(settingsPath()) ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Last resort when fx names no default and its catalog cannot be read: the subscription models seen 2026-11-03. */
export const FX_FALLBACK_MODEL: Partial<Record<FxProvider, string>> = { codex: "gpt-6.1-sol", grok: "grok-4.7" };

/** The ids in `fx models --json` output (`ids`, or `models[].id`); [] when fx could not list them (not logged in, old fx). */
export function parseFxModels(stdout: string): string[] {
  try {
    const j = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "") as { ids?: unknown; models?: unknown };
    const ids = Array.isArray(j.ids) ? j.ids : Array.isArray(j.models) ? (j.models as Array<{ id?: unknown }>).map((m) => m?.id) : [];
    return ids.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

/** The model a call runs on: the explicit one, else fx's default for the provider, else the catalog's first, else the fallback. */
export function pickFxModel(i: { provider: FxProvider; explicit?: string; settingsDefault?: string; catalog?: string[] }): string | undefined {
  return i.explicit ?? i.settingsDefault ?? i.catalog?.[0] ?? FX_FALLBACK_MODEL[i.provider];
}

/** fx's words when the subscription does not offer the model the call asked for. */
export const isModelRefused = (s: string | undefined): boolean => /model_not_found|model[^.]{0,80}not (supported|available|found)|unknown model|no such model/i.test(s ?? "");

interface Exec {
  stdout: string;
  stderr: string;
  code: number;
}

const exec = (bin: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<Exec> =>
  new Promise((resolve) => {
    const child = execFile(bin, args, { ...(o.cwd ? { cwd: o.cwd } : {}), env: o.env, maxBuffer: 64 * 1024 * 1024, timeout: o.timeout }, (err, stdout, stderr) =>
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0 }),
    );
    child.stdin?.end();
  });

/** Gateway-style model id for the ledger price table. */
function ledgerModelId(provider: FxProvider, model: string): string {
  if (model.includes("/")) return model;
  if (provider === "codex") return `openai/${model}`;
  if (provider === "grok") return `xai/${model}`;
  return model;
}

export async function runFx(req: LaneRequest, opts: FxOptions): Promise<LaneResult> {
  const bin = opts.bin ?? cliBin("fx");
  const subscription: Subscription = opts.provider === "gateway" ? "gateway" : opts.provider;
  const fxProvider = opts.provider === "gateway" ? "vercel" : opts.provider;
  const baseEnv = { ...(req.env ?? process.env), FX_NO_OPEN_BROWSER: "1", FX_AUTO_UPGRADE: "0" };
  return withSubscriptionLock(`fx:${opts.provider}`, async () => {
    mkdirSync(fxHome(), { recursive: true });
    const before = readSettings();
    const settingsModels = (before["models"] as Record<string, string> | undefined) ?? {};
    const settings = (model?: string): string => JSON.stringify({ ...before, models: model ? { ...settingsModels, [fxProvider]: model } : settingsModels, provider: fxProvider });
    // global launch options come before the subcommand; skill_catalog_bytes trims fx's built-in skill catalog
    // (7.1 K → 4.5 K input tokens on a bare call, measured 2026-09-23). Harness skills arrive via --add-dir.
    const args = ["--context-limit", `skill_catalog_bytes=${opts.skillCatalogBytes ?? 1024}`];
    for (const d of req.addDirs ?? []) args.push("--add-dir", d);
    args.push("ask", "--json", "--no-save", "--quiet");
    if (req.system) args.push("--system", req.system);
    if (!req.readOnly) args.push("--auto");
    args.push("--", req.prompt);

    let catalog: string[] | undefined;
    const listModels = async (): Promise<string[]> => {
      if (catalog) return catalog;
      writeFileSync(settingsPath(), settings());
      const r = await exec(bin, ["models", "--json"], { env: baseEnv, timeout: 30_000 });
      catalog = parseFxModels(r.stdout);
      return catalog;
    };
    const ask = async (model: string): Promise<LaneResult> => {
      writeFileSync(settingsPath(), settings(model));
      const t0 = Date.now();
      const { stdout, stderr, code } = await exec(bin, args, { cwd: req.cwd, env: { ...baseEnv, FX_MODEL: model }, timeout: req.timeoutMs ?? 20 * 60_000 });
      const durationMs = Date.now() - t0;
      let j: FxAskJson | undefined;
      try {
        j = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "") as FxAskJson;
      } catch {
        /* fall through */
      }
      const ledgerModel = ledgerModelId(opts.provider, j?.model || model);
      const tokensIn = j?.usage?.input_tokens ?? 0;
      const tokensOut = j?.usage?.output_tokens ?? 0;
      const ok = !!j && j.exit_code === 0 && !j.error && code === 0;
      const res: LaneResult = {
        ok,
        text: j?.final_output || j?.output || "",
        model: ledgerModel,
        subscription,
        tokensIn,
        tokensOut,
        cacheRead: 0,
        cacheWrite: 0,
        costEquiv: costEquiv({ lane: req.lane, model: ledgerModel, provider: opts.provider, subscription, tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs }),
        durationMs,
        raw: j ?? { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000), code },
      };
      if (j?.session_id) res.sessionId = j.session_id;
      if (!ok) res.error = j?.error ?? (j?.output || stderr || `fx exited ${code}`).slice(0, 500);
      return res;
    };

    try {
      // the caller's model, else fx's own default for the provider; only then the catalog (one process) and the fallback
      let model: string | undefined = opts.model ?? settingsModels[fxProvider];
      if (!model) model = pickFxModel({ provider: opts.provider, catalog: await listModels() });
      if (!model) return { ok: false, text: "", model: `${opts.provider}/unknown`, subscription, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0, durationMs: 0, raw: { catalog: catalog ?? [] }, error: `no model for the fx ${opts.provider} provider: fx names no default, its catalog is empty; pass one (RELAY_MODEL_${opts.provider.toUpperCase()})` };
      let res = await ask(model);
      if (!res.ok && isModelRefused(res.error)) {
        // the subscription's catalog moved under the pinned model: once more on what it offers today
        const next = (await listModels()).find((m) => m !== model);
        if (next) {
          const first = res.error;
          res = await ask(next);
          res.raw = { ...(typeof res.raw === "object" && res.raw ? (res.raw as Record<string, unknown>) : {}), retried_from: model, refused: first };
        }
      }
      return res;
    } finally {
      writeFileSync(settingsPath(), JSON.stringify(before));
    }
  });
}
