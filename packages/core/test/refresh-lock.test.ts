import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultConfig, type HarnessConfig } from "../src/config.ts";
import type { HttpFetch } from "../src/client/http.ts";
import { readSiteConfig, writeSiteConfig } from "../src/client/site.ts";
import { refreshSiteToken, refreshSiteTokenIfStale } from "../src/harness.ts";

/**
 * Two processes share one credentials.json (a CLI command and the MCP bridge, a worker and a hook). A refresh rotates
 * the refresh token and the server revokes the whole chain when the old one is used again, so refreshes must be
 * serialised and a refresher must adopt a pair another process stored instead of spending its own stale one.
 */

const SITE = "https://relay.test";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A token endpoint with rotation and reuse detection, counting the refreshes it served. */
function fakeServer(initialRefresh: string) {
  let current = initialRefresh;
  let n = 0;
  const revoked = new Set<string>();
  const fetchImpl: HttpFetch = async (url, init) => {
    expect(url).toBe(`${SITE}/oauth/token`);
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    const rt = form.get("refresh_token") ?? "";
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body) });
    if (rt !== current || revoked.has(rt)) {
      revoked.add(current); // the chain leaked: everything after it dies
      return json(400, { error: "invalid_grant", error_description: "The refresh token was revoked." });
    }
    n += 1;
    current = `rrt_${n}`;
    return json(200, { access_token: `rly_${n}`, token_type: "bearer", expires_in: 86_400, refresh_token: current, scope: "feed:read", token_name: "oauth:relay-cli@test" });
  };
  return { fetchImpl, refreshes: () => n, current: () => current };
}

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-refresh-"));
  dirs.push(d);
  return d;
}

function staleCfg(h: string): HarnessConfig {
  const expiresAt = new Date(NOW - 60_000).toISOString(); // already lapsed
  writeSiteConfig({ site: SITE, token: { token: "rly_0", refreshToken: "rrt_0", expiresAt, source: "device", tokenName: "oauth:relay-cli@test" } }, h);
  return { ...defaultConfig(), home: h, site: SITE, siteToken: "rly_0", siteRefreshToken: "rrt_0", siteTokenExpiresAt: expiresAt, siteTokenSource: "device", siteTokenName: "oauth:relay-cli@test" };
}

describe("site token refresh across processes", () => {
  it("two refreshers with the same stale credential make one request and end with the same pair", async () => {
    const h = home();
    const cfg = staleCfg(h);
    const server = fakeServer("rrt_0");
    const [a, b] = await Promise.all([refreshSiteToken(cfg, NOW, { fetch: server.fetchImpl }), refreshSiteToken(cfg, NOW, { fetch: server.fetchImpl })]);
    expect(server.refreshes()).toBe(1);
    expect(a.siteToken).toBe("rly_1");
    expect(b.siteToken).toBe("rly_1");
    expect(a.siteRefreshToken).toBe("rrt_1");
    expect(readSiteConfig(h).token).toBe("rly_1");
    expect(server.current()).toBe("rrt_1"); // the chain is intact
  });

  it("adopts a pair another process stored instead of spending a stale refresh token", async () => {
    const h = home();
    const cfg = staleCfg(h);
    const server = fakeServer("rrt_0");
    // "another process" renewed and wrote the file while this one still holds rly_0 in memory
    writeSiteConfig({ site: SITE, token: { token: "rly_9", refreshToken: "rrt_9", expiresAt: new Date(NOW + 80_000_000).toISOString(), source: "device", tokenName: "oauth:relay-cli@test" } }, h);
    const next = await refreshSiteTokenIfStale(cfg, NOW);
    expect(next.siteToken).toBe("rly_9");
    expect(next.siteRefreshToken).toBe("rrt_9");
    expect(server.refreshes()).toBe(0);
  });

  it("a refused refresh still fails with the setup hint when nobody else renewed", async () => {
    const h = home();
    const cfg = staleCfg(h);
    const server = fakeServer("rrt_other");
    await expect(refreshSiteToken(cfg, NOW, { fetch: server.fetchImpl })).rejects.toThrow(/invalid_grant.*relay setup --site/);
  });

  it("a dead lock from a crashed process is taken over", async () => {
    const h = home();
    const cfg = staleCfg(h);
    const { writeFileSync, utimesSync } = await import("node:fs");
    const lock = join(h, "credentials.json.lock");
    writeFileSync(lock, "99999 long ago\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const server = fakeServer("rrt_0");
    const next = await refreshSiteToken(cfg, NOW, { fetch: server.fetchImpl });
    expect(next.siteToken).toBe("rly_1");
  });
});
