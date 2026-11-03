/**
 * The fx lane's model choice: the caller's, else the login's own (fx settings, then `fx models --json`), and one retry
 * when the subscription refuses the model (2026-11-03: the Codex sub dropped gpt-5.5 and a pinned lane failed on it).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FX_FALLBACK_MODEL, isModelRefused, parseFxModels, pickFxModel, runFx } from "../src/lanes/fx.ts";

const REFUSAL = "API request failed · HTTP 400 · model_not_found: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";

describe("parseFxModels", () => {
  it("reads the ids of fx models --json, either shape, and nothing from an error", () => {
    expect(parseFxModels('{"kind":"models","count":2,"ids":["gpt-6.1-sol","gpt-6-astra"],"models":[{"id":"gpt-6.1-sol"},{"id":"gpt-6-astra"}]}\n')).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
    expect(parseFxModels('{"models":[{"id":"grok-4.7","source":"Grok subscription"}]}')).toEqual(["grok-4.7"]);
    expect(parseFxModels('{"kind":"models","error":"could not list models: AuthenticationRejected","code":"AuthenticationRejected"}')).toEqual([]);
    expect(parseFxModels("not json")).toEqual([]);
  });
});

describe("pickFxModel", () => {
  it("prefers the caller, then fx's default, then the catalog, then the fallback", () => {
    expect(pickFxModel({ provider: "codex", explicit: "gpt-6-astra", settingsDefault: "gpt-6.1-sol", catalog: ["gpt-6.1-terra"] })).toBe("gpt-6-astra");
    expect(pickFxModel({ provider: "codex", settingsDefault: "gpt-6.1-sol", catalog: ["gpt-6.1-terra"] })).toBe("gpt-6.1-sol");
    expect(pickFxModel({ provider: "codex", catalog: ["gpt-6.1-terra", "gpt-6-sol"] })).toBe("gpt-6.1-terra");
    expect(pickFxModel({ provider: "codex", catalog: [] })).toBe(FX_FALLBACK_MODEL.codex);
    expect(pickFxModel({ provider: "grok" })).toBe("grok-4.7");
    expect(pickFxModel({ provider: "gateway", catalog: [] })).toBeUndefined();
  });
});

describe("isModelRefused", () => {
  it("recognises the subscription's refusal and not other failures", () => {
    expect(isModelRefused(REFUSAL)).toBe(true);
    expect(isModelRefused("model_not_found")).toBe(true);
    expect(isModelRefused("Unknown model 'gpt-9'")).toBe(true);
    expect(isModelRefused("fx exited 1")).toBe(false);
    expect(isModelRefused("rate limit reached for this model")).toBe(false);
    expect(isModelRefused(undefined)).toBe(false);
  });
});

describe("runFx", () => {
  let dir: string;
  let fxHome: string;
  let bin: string;
  let log: string;
  const calls = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const settings = (): Record<string, unknown> => JSON.parse(readFileSync(join(fxHome, "settings.json"), "utf8")) as Record<string, unknown>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-fx-"));
    fxHome = join(dir, "fx-home");
    log = join(dir, "calls.log");
    bin = join(dir, "fx");
    // A stand-in fx: `models --json` lists two models; `ask` refuses FX_MODEL=gpt-stale the way the Codex sub does.
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$FX_MODEL $*" >> "$FX_LOG"
case "$*" in
  *"models --json"*) echo '{"kind":"models","ids":["gpt-new","gpt-older"]}'; exit 0;;
esac
if [ "$FX_MODEL" = "gpt-stale" ]; then
  echo '{"output":"${REFUSAL.replace(/'/g, "'\"'\"'")}","final_output":"","exit_code":1,"model":"gpt-stale","session_id":"s1","steps":0,"tool_calls":[],"usage":{"input_tokens":0,"output_tokens":0},"error":"${REFUSAL.replace(/'/g, "'\"'\"'")}"}'
  exit 1
fi
echo "{\\"output\\":\\"pong\\",\\"final_output\\":\\"pong\\",\\"exit_code\\":0,\\"model\\":\\"$FX_MODEL\\",\\"session_id\\":\\"s2\\",\\"steps\\":1,\\"tool_calls\\":[],\\"usage\\":{\\"input_tokens\\":10,\\"output_tokens\\":2}}"
`,
    );
    chmodSync(bin, 0o755);
    process.env.FX_HOME_DIR = fxHome;
  });
  afterAll(() => {
    delete process.env.FX_HOME_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const req = (): { lane: "code"; prompt: string; cwd: string; readOnly: boolean; env: NodeJS.ProcessEnv } => ({ lane: "code", prompt: "ping", cwd: dir, readOnly: true, env: { PATH: process.env.PATH ?? "", HOME: dir, FX_LOG: log } });

  it("retries a refused model once with what the login offers, and says so", async () => {
    rmSync(log, { force: true });
    const r = await runFx(req(), { provider: "codex", model: "gpt-stale", bin });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("pong");
    expect(r.model).toBe("openai/gpt-new");
    expect((r.raw as { retried_from?: string; refused?: string }).retried_from).toBe("gpt-stale");
    expect((r.raw as { refused?: string }).refused).toContain("model_not_found");
    const c = calls();
    expect(c[0]).toContain("gpt-stale");
    expect(c[0]).toContain(" ask ");
    expect(c[1]).toContain("models --json");
    expect(c[2]?.startsWith("gpt-new ")).toBe(true);
    expect(settings()).toEqual({}); // restored
  });

  it("uses fx's own default for the provider when the caller names none, without listing", async () => {
    rmSync(log, { force: true });
    writeFileSync(join(fxHome, "settings.json"), JSON.stringify({ models: { codex: "gpt-6.1-sol", grok: "grok-4.7" }, provider: "grok" }));
    const r = await runFx(req(), { provider: "codex", bin });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("openai/gpt-6.1-sol");
    expect(calls()).toHaveLength(1);
    expect(settings()).toEqual({ models: { codex: "gpt-6.1-sol", grok: "grok-4.7" }, provider: "grok" }); // restored
  });

  it("asks fx for the catalog when it names no default either", async () => {
    rmSync(log, { force: true });
    writeFileSync(join(fxHome, "settings.json"), JSON.stringify({ provider: "grok" }));
    const r = await runFx(req(), { provider: "codex", bin });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("openai/gpt-new");
    const c = calls();
    expect(c[0]).toContain("models --json");
    expect(c[1]?.startsWith("gpt-new ")).toBe(true);
  });
});
