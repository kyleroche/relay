/**
 * Site mode configuration. `relay setup --site <url>` writes the URL into ~/.harness/config.json (`site`) and the
 * credential into ~/.harness/credentials.json at mode 0600, separate from the file users share and edit. The
 * credential is the access token plus, when it came from the device flow or an invite, the refresh token, its expiry
 * and where it came from (`source`), so `openHarness` can refresh it before it lapses. The environment overrides the
 * site and token (RELAY_SITE, RELAY_TOKEN) for CI and tests. Nothing else is read or written here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSite } from "./http.ts";

export type TokenSource = "device" | "invite" | "manual" | "env";

export interface SiteConfig {
  site?: string;
  token?: string;
  refreshToken?: string;
  /** ISO time the access token stops working; absent for operator-minted tokens. */
  tokenExpiresAt?: string;
  /** How the token got here: approved on /activate, an invite code, pasted with --token, or RELAY_TOKEN. */
  tokenSource?: TokenSource;
  /** The token's name on the site when known (`oauth:<client name>`). */
  tokenName?: string;
  /** Where each value came from, for `relay doctor`. */
  sources: { site?: "env" | "file"; token?: "env" | "file" };
}

export const credentialsPath = (home: string = process.env.RELAY_HOME ?? join(homedir(), ".harness")): string => join(home, "credentials.json");
export const configPath = (home: string = process.env.RELAY_HOME ?? join(homedir(), ".harness")): string => join(home, "config.json");

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function readSiteConfig(home?: string, env: Record<string, string | undefined> = process.env): SiteConfig {
  const out: SiteConfig = { sources: {} };
  const cfg = readJson(configPath(home));
  if (strOf(cfg.site)) {
    out.site = normalizeSite(cfg.site as string);
    out.sources.site = "file";
  }
  const creds = readJson(credentialsPath(home));
  if (strOf(creds.token)) {
    out.token = strOf(creds.token);
    out.sources.token = "file";
    const refresh = strOf(creds.refresh_token);
    if (refresh) out.refreshToken = refresh;
    const exp = strOf(creds.expires_at);
    if (exp) out.tokenExpiresAt = exp;
    const source = strOf(creds.source);
    if (source === "device" || source === "invite" || source === "manual") out.tokenSource = source;
    else out.tokenSource = "manual";
    const name = strOf(creds.token_name);
    if (name) out.tokenName = name;
  }
  if (env.RELAY_SITE?.trim()) {
    out.site = normalizeSite(env.RELAY_SITE);
    out.sources.site = "env";
  }
  if (env.RELAY_TOKEN?.trim()) {
    out.token = env.RELAY_TOKEN.trim();
    out.sources.token = "env";
    out.tokenSource = "env";
    delete out.refreshToken;
    delete out.tokenExpiresAt;
    delete out.tokenName;
  }
  return out;
}

export interface SiteCredential {
  token: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  source?: TokenSource;
  tokenName?: string | null;
}

/**
 * Write (or with `site: null` remove) the site entry; the credential goes to credentials.json at 0600. `token: null`
 * removes the credential; `undefined` leaves it alone.
 */
export function writeSiteConfig(input: { site: string | null; token?: SiteCredential | string | null }, home?: string): { configPath: string; credentialsPath: string } {
  const cp = configPath(home);
  const kp = credentialsPath(home);
  mkdirSync(join(cp, ".."), { recursive: true });
  const cfg = readJson(cp);
  if (input.site === null) delete cfg.site;
  else cfg.site = normalizeSite(input.site);
  writeFileSync(cp, JSON.stringify(cfg, null, 2) + "\n");
  if (input.token !== undefined) {
    const creds = readJson(kp);
    for (const k of ["token", "refresh_token", "expires_at", "source", "token_name"]) delete creds[k];
    if (input.token !== null) {
      const c: SiteCredential = typeof input.token === "string" ? { token: input.token, source: "manual" } : input.token;
      creds.token = c.token;
      if (c.refreshToken) creds.refresh_token = c.refreshToken;
      if (c.expiresAt) creds.expires_at = c.expiresAt;
      creds.source = c.source ?? "manual";
      if (c.tokenName) creds.token_name = c.tokenName;
    }
    writeFileSync(kp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(kp, 0o600);
    } catch {
      /* best effort on filesystems without modes */
    }
  }
  return { configPath: cp, credentialsPath: kp };
}

export function validateSiteUrl(site: string): string | undefined {
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return "site must be an absolute URL, e.g. https://relay.example.com";
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(u.host))) return "site must use https (http is allowed for localhost only)";
  if (u.pathname !== "/" && u.pathname !== "") return "site must be the origin only, without a path";
  return undefined;
}
