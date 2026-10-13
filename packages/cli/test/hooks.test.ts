import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { briefCachePath, writeCachedBrief } from "@relay/core";
import { briefCacheKey, SESSION_START_INTENT, SESSION_START_TOKENS } from "../src/commands/brief.ts";

const HOOKS = resolve(import.meta.dirname, "..", "hooks");
let tmp: string;
let home: string;
let linked: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-cli-hooks-"));
  home = join(tmp, "harness");
  linked = join(tmp, "repo", "sub");
  mkdirSync(join(tmp, "repo", ".relay"), { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(tmp, "repo", ".relay", "rules.json"), JSON.stringify({ version: 1, project: "demo", sections: {} }));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runHook(script: string, payload: unknown, cli = "claude") {
  const r = spawnSync(process.execPath, [join(HOOKS, script), "--cli", cli], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, RELAY_HOME: home }, timeout: 20_000 });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

describe("hook scripts", () => {
  it("_lib computes the same cache path and key as the CLI and core", async () => {
    process.env.RELAY_HOME = home;
    const lib = (await import("../hooks/_lib.mjs")) as { briefCachePath: (p: string, k: string) => string; briefCacheKey: (i: string, n: number, m?: string, l?: string) => string; linkedProject: (cwd: string) => { root: string; project: string } | null };
    const key = briefCacheKey(SESSION_START_INTENT, SESSION_START_TOKENS, undefined, "claude");
    expect(lib.briefCacheKey(SESSION_START_INTENT, SESSION_START_TOKENS, "", "claude")).toBe(key);
    expect(lib.briefCachePath("demo", key)).toBe(briefCachePath("demo", key, home));
    expect(lib.linkedProject(linked)).toEqual({ root: join(tmp, "repo"), project: "demo" });
    expect(lib.linkedProject(tmp)).toBeNull();
  });

  it("session-start prints the cached brief for a linked cwd without spawning the CLI, and stays silent elsewhere", () => {
    const key = briefCacheKey(SESSION_START_INTENT, SESSION_START_TOKENS, undefined, "claude");
    writeCachedBrief({ project: "demo", key, text: "## Preferences (hard rules)\n\n- x = y\n", tokens: 9 }, home);
    const t0 = Date.now();
    const hit = runHook("session-start.mjs", { cwd: linked, session_id: "s1" });
    expect(hit.status).toBe(0);
    expect(hit.out).toBe("# relay brief for demo\n\n## Preferences (hard rules)\n\n- x = y\n");
    expect(Date.now() - t0).toBeLessThan(5000);

    const miss = runHook("session-start.mjs", { cwd: tmp });
    expect(miss).toMatchObject({ status: 0, out: "" });
    // a codex session has its own cache key (lane), so it misses the claude entry and falls through to the CLI, which is silent for an unknown project
    const codex = runHook("session-start.mjs", { cwd: linked }, "codex");
    expect(codex.status).toBe(0);
    expect(codex.out).not.toContain("- x = y");
  });

  it("user-prompt skips short prompts, slash commands and unlinked cwds", () => {
    expect(runHook("user-prompt.mjs", { cwd: linked, prompt: "yes" })).toMatchObject({ status: 0, out: "" });
    expect(runHook("user-prompt.mjs", { cwd: linked, prompt: "/clear the whole conversation now" })).toMatchObject({ status: 0, out: "" });
    expect(runHook("user-prompt.mjs", { cwd: tmp, prompt: "please add a test for the parser module" })).toMatchObject({ status: 0, out: "" });
  });

  it("session-end exits at once without a transcript or outside a linked repo", () => {
    expect(runHook("session-end.mjs", { cwd: linked })).toMatchObject({ status: 0, out: "" });
    expect(runHook("session-end.mjs", { cwd: tmp, transcript_path: join(tmp, "nope.jsonl") })).toMatchObject({ status: 0, out: "" });
  });
});
