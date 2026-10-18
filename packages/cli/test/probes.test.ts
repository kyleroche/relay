import { describe, it, expect } from "vitest";
import { defaultConfig, type HarnessConfig } from "@relay/core";
import { mcpCheck } from "../src/commands/probes.ts";
import { pathCheck } from "../src/commands/probes.ts";

const ENTRY = "/opt/relay/dist/relay-mcp.js";
const siteCfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({ ...defaultConfig(), site: "https://relay.example.com", siteToken: "rly_secret", siteTokenName: "oauth:relay-cli@mac", siteTokenSource: "device", ...over });

describe("relay doctor: the mcp line", () => {
  it("local mode: the installed entry serves the database here", async () => {
    const cfg = defaultConfig();
    const c = await mcpCheck(cfg, { entry: ENTRY });
    expect(c).toEqual({ status: "ok", name: "mcp", detail: `local mode: ${ENTRY} serves pglite at ${cfg.dbFile}` });
    const pg = await mcpCheck({ ...cfg, databaseUrl: "postgres://x" }, { entry: ENTRY });
    expect(pg.detail).toBe(`local mode: ${ENTRY} serves postgres via DATABASE_URL`);
    // a site without a credential is not site mode (doctor's mode line already fails it)
    expect((await mcpCheck({ ...cfg, site: "https://relay.example.com" }, { entry: ENTRY })).detail).toMatch(/^local mode/);
  });

  it("site mode: names the site and the token, and proves tools/list answers with one call", async () => {
    const calls: Array<{ site: string; token: string }> = [];
    let t = 1000;
    const c = await mcpCheck(siteCfg(), {
      entry: ENTRY,
      now: () => (t += 42),
      listTools: async (o) => {
        calls.push({ site: o.site, token: o.token });
        return { tools: ["relay_recall", "relay_decide", "relay_whoami"] };
      },
    });
    expect(calls).toEqual([{ site: "https://relay.example.com", token: "rly_secret" }]);
    expect(c.status).toBe("ok");
    expect(c.detail).toBe(`site mode: ${ENTRY} forwards to https://relay.example.com as oauth:relay-cli@mac; tools/list answered with 3 tools, 42 ms`);
    expect(c.detail).not.toContain("rly_secret");
  });

  it("site mode: a refused token or an unreachable site fails the line with the site's message", async () => {
    const refused = await mcpCheck(siteCfg({ siteTokenName: undefined, siteTokenSource: "manual" }), { entry: ENTRY, listTools: async () => Promise.reject(new Error("unauthorized: unknown, expired or revoked bearer token.")) });
    expect(refused.status).toBe("fail");
    expect(refused.detail).toBe(`site mode: ${ENTRY} forwards to https://relay.example.com as a pasted token; tools/list failed: unauthorized: unknown, expired or revoked bearer token.`);
    const down = await mcpCheck(siteCfg(), { entry: ENTRY, listTools: async () => Promise.reject(new Error("relay-mcp: cannot reach https://relay.example.com/mcp: ECONNREFUSED")) });
    expect(down.status).toBe("fail");
    expect(down.detail).toMatch(/tools\/list failed: relay-mcp: cannot reach/);
  });
});

describe("pathCheck", () => {
  it("is ok when relay resolves on PATH", () => {
    expect(pathCheck({ onPath: (b) => (b === "relay" ? "/usr/local/bin/relay" : undefined) })).toEqual({ status: "ok", name: "path", detail: "relay on PATH: /usr/local/bin/relay" });
  });
  it("warns with npm's bin directory and the shell's rc file when relay is missing", () => {
    const c = pathCheck({ onPath: () => undefined, npmPrefix: () => "/opt/homebrew", shell: "/bin/zsh", running: "/Users/w/.npm/_npx/abc/node_modules/.bin/relay", pathEnv: "/usr/bin:/bin" });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("npm install -g @kyleroche/relay");
    expect(c.detail).toContain("/opt/homebrew/bin");
    expect(c.detail).toContain("~/.zshrc");
  });
  it("still gives a fix when npm cannot say where its prefix is", () => {
    const c = pathCheck({ onPath: () => undefined, npmPrefix: () => undefined, shell: "/bin/bash", running: "/usr/local/lib/node_modules/@kyleroche/relay/dist/relay.js", pathEnv: "/usr/bin:/bin" });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("npm prefix -g");
    expect(c.detail).toContain("~/.bashrc");
    expect(c.detail).not.toContain("npm install -g");
  });
  it("says the command is simply not installed when npm's bin directory is already on PATH", () => {
    const c = pathCheck({ onPath: () => undefined, npmPrefix: () => "/opt/homebrew", shell: "/bin/zsh", running: "/w/relay/bin/relay", pathEnv: "/opt/homebrew/bin:/usr/bin" });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("not installed as a command");
    expect(c.detail).not.toContain(".zshrc");
  });
});
