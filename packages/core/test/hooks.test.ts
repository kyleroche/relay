import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, planSetup, spliceTomlBlock, TOML_BEGIN, TOML_END, type HookContext } from "../src/hooks/index.ts";
import { readCachedBrief, writeCachedBrief, invalidateBriefCache, briefCachePath } from "../src/hooks/cache.ts";

let tmp: string;
let ctx: HookContext;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-hooks-"));
  ctx = { userHome: join(tmp, "home"), relayHome: join(tmp, "harness"), repoRoot: "/opt/relay", node: "/usr/local/bin/node" };
  mkdirSync(ctx.userHome, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const read = (p: string) => readFileSync(p, "utf8");

describe("hook installers", () => {
  it("plans nothing for undetected CLIs unless --only", () => {
    const path = process.env.PATH;
    process.env.PATH = join(tmp, "empty-bin"); // detection also looks on PATH; keep the test hermetic
    try {
      const plans = planSetup(ctx);
      expect(plans.every((p) => !p.detected && p.files.length === 0)).toBe(true);
      const only = planSetup(ctx, { only: "codex" });
      expect(only).toHaveLength(1);
      expect(only[0]!.files[0]!.action).toBe("create");
    } finally {
      process.env.PATH = path;
    }
  });

  it("claude: merges into settings.json and ~/.claude.json, keeps foreign hooks, idempotent, removable", () => {
    mkdirSync(join(ctx.userHome, ".claude"));
    writeFileSync(join(ctx.userHome, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }] } }));
    writeFileSync(join(ctx.userHome, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }));
    const [plan] = planSetup(ctx, { only: "claude" });
    expect(plan!.files.map((f) => f.action)).toEqual(["update", "update"]);
    applyPlan(plan!);
    const s = JSON.parse(read(join(ctx.userHome, ".claude", "settings.json"))) as { theme: string; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(s.theme).toBe("dark");
    expect(s.hooks.PreToolUse![0]!.hooks[0]!.command).toBe("lint");
    expect(s.hooks.SessionStart!.map((e) => e.hooks[0]!.command)).toEqual(["echo mine", "/usr/local/bin/node /opt/relay/packages/cli/hooks/session-start.mjs --cli claude"]);
    expect(s.hooks.UserPromptSubmit![0]!.hooks[0]!.command).toContain("user-prompt.mjs --cli claude");
    expect(s.hooks.SessionEnd![0]!.hooks[0]!.command).toContain("session-end.mjs --cli claude");
    const c = JSON.parse(read(join(ctx.userHome, ".claude.json"))) as { numStartups: number; mcpServers: Record<string, { command: string; args: string[] }> };
    expect(c.numStartups).toBe(3);
    expect(c.mcpServers.other!.command).toBe("x");
    expect(c.mcpServers.relay!.args).toEqual(["/opt/relay/packages/mcp/bin/relay-mcp.mjs"]);

    const [again] = planSetup(ctx, { only: "claude" });
    expect(again!.files.map((f) => f.action)).toEqual(["unchanged", "unchanged"]);
    expect(again!.notes.join("\n")).toContain("claude mcp add --scope user");

    const [removal] = planSetup(ctx, { only: "claude", remove: true });
    applyPlan(removal!);
    const s2 = JSON.parse(read(join(ctx.userHome, ".claude", "settings.json"))) as { hooks: Record<string, unknown[]> };
    expect(s2.hooks.SessionStart).toHaveLength(1);
    expect(s2.hooks.UserPromptSubmit).toBeUndefined();
    expect(s2.hooks.PreToolUse).toHaveLength(1);
    const c2 = JSON.parse(read(join(ctx.userHome, ".claude.json"))) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(c2.mcpServers)).toEqual(["other"]);
  });

  it("codex: owns one block in config.toml, keeps the user's tables, says UserPromptSubmit is unsupported", () => {
    mkdirSync(join(ctx.userHome, ".codex"));
    const toml = join(ctx.userHome, ".codex", "config.toml");
    writeFileSync(toml, 'model = "gpt-6-astra"\n\n[profiles.fast]\nmodel = "gpt-5.5"\n');
    const [plan] = planSetup(ctx, { only: "codex" });
    applyPlan(plan!);
    const out = read(toml);
    expect(out.startsWith('model = "gpt-6-astra"\n\n[profiles.fast]\nmodel = "gpt-5.5"\n')).toBe(true);
    expect(out).toContain(TOML_BEGIN);
    expect(out).toContain("[mcp_servers.relay]");
    expect(out).toContain('args = ["/opt/relay/packages/mcp/bin/relay-mcp.mjs"]');
    expect(out).toContain("[[hooks.SessionStart]]");
    expect(out).not.toContain("UserPromptSubmit");
    expect(plan!.notes.join("\n")).toMatch(/no UserPromptSubmit hook/);
    expect(planSetup(ctx, { only: "codex" })[0]!.files[0]!.action).toBe("unchanged");

    // a changed node path updates the block in place, once
    const moved = { ...ctx, node: "/opt/node24/bin/node" };
    applyPlan(planSetup(moved, { only: "codex" })[0]!);
    const out2 = read(toml);
    expect(out2.split(TOML_BEGIN)).toHaveLength(2);
    expect(out2).toContain('command = "/opt/node24/bin/node"');
    expect(out2).not.toContain("/usr/local/bin/node");

    applyPlan(planSetup(ctx, { only: "codex", remove: true })[0]!);
    expect(read(toml)).toBe('model = "gpt-6-astra"\n\n[profiles.fast]\nmodel = "gpt-5.5"\n');
  });

  it("spliceTomlBlock handles empty files and removal", () => {
    expect(spliceTomlBlock("", `${TOML_BEGIN}\nx = 1\n${TOML_END}`)).toBe(`${TOML_BEGIN}\nx = 1\n${TOML_END}\n`);
    expect(spliceTomlBlock("a = 1\n", undefined)).toBe("a = 1\n");
    expect(spliceTomlBlock(`${TOML_BEGIN}\nx = 1\n${TOML_END}\n`, undefined)).toBe("");
  });

  it("grok: writes hooks/relay.json with the three events and the MCP server into settings.json", () => {
    mkdirSync(join(ctx.userHome, ".grok"));
    writeFileSync(join(ctx.userHome, ".grok", "settings.json"), JSON.stringify({ model: "grok-4.7" }));
    const [plan] = planSetup(ctx, { only: "grok" });
    expect(plan!.files.map((f) => f.action)).toEqual(["create", "update"]);
    applyPlan(plan!);
    const hooks = JSON.parse(read(join(ctx.userHome, ".grok", "hooks", "relay.json"))) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
    expect(hooks.hooks.Stop![0]!.hooks[0]!.command).toContain("session-end.mjs --cli grok");
    const s = JSON.parse(read(join(ctx.userHome, ".grok", "settings.json"))) as { model: string; mcpServers: { relay: { command: string } } };
    expect(s.model).toBe("grok-4.7");
    expect(s.mcpServers.relay.command).toBe("/usr/local/bin/node");
    expect(plan!.notes.join("\n")).toContain("grok mcp add relay");
    expect(planSetup(ctx, { only: "grok" })[0]!.files.every((f) => f.action === "unchanged")).toBe(true);
  });
});

describe("brief cache", () => {
  it("round-trips under RELAY_HOME, expires, and invalidates per project", () => {
    const home = ctx.relayHome;
    const p = writeCachedBrief({ project: "demo", key: "k", text: "hello", tokens: 1 }, home);
    expect(p).toBe(briefCachePath("demo", "k", home));
    expect(readCachedBrief("demo", "k", { home })?.text).toBe("hello");
    expect(readCachedBrief("demo", "k", { home, ttlMs: -1 })).toBeUndefined();
    expect(readCachedBrief("demo", "other", { home })).toBeUndefined();
    writeCachedBrief({ project: "other", key: "k", text: "x", tokens: 1 }, home);
    expect(invalidateBriefCache("demo", home)).toBe(1);
    expect(readCachedBrief("demo", "k", { home })).toBeUndefined();
    expect(readCachedBrief("other", "k", { home })?.text).toBe("x");
    expect(invalidateBriefCache(undefined, home)).toBe(1);
  });
});
