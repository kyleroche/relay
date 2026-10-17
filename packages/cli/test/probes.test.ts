import { describe, it, expect } from "vitest";
import { defaultConfig, type HarnessConfig } from "@relay/core";
import { mcpCheck } from "../src/commands/probes.ts";

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
