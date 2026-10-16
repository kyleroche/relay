/**
 * Site mode configuration. `relay setup --site <url> --token <t>` writes the URL into ~/.harness/config.json (`site`)
 * and the token into ~/.harness/credentials.json at mode 0600, separate from the file users share and edit. The
 * environment overrides both (RELAY_SITE, RELAY_TOKEN) for CI and tests. Nothing else is read or written here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSite } from "./http.ts";

export interface SiteConfig {
  site?: string;
  token?: string;
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

export function readSiteConfig(home?: string, env: Record<string, string | undefined> = process.env): SiteConfig {
  const out: SiteConfig = { sources: {} };
  const cfg = readJson(configPath(home));
  if (typeof cfg.site === "string" && cfg.site.trim()) {
    out.site = normalizeSite(cfg.site);
    out.sources.site = "file";
  }
  const creds = readJson(credentialsPath(home));
  if (typeof creds.token === "string" && creds.token.trim()) {
    out.token = creds.token.trim();
    out.sources.token = "file";
  }
  if (env.RELAY_SITE?.trim()) {
    out.site = normalizeSite(env.RELAY_SITE);
    out.sources.site = "env";
  }
  if (env.RELAY_TOKEN?.trim()) {
    out.token = env.RELAY_TOKEN.trim();
    out.sources.token = "env";
  }
  return out;
}

/** Write (or with `site: null` remove) the site entry; the token goes to credentials.json at 0600. */
export function writeSiteConfig(input: { site: string | null; token?: string | null }, home?: string): { configPath: string; credentialsPath: string } {
  const cp = configPath(home);
  const kp = credentialsPath(home);
  mkdirSync(join(cp, ".."), { recursive: true });
  const cfg = readJson(cp);
  if (input.site === null) delete cfg.site;
  else cfg.site = normalizeSite(input.site);
  writeFileSync(cp, JSON.stringify(cfg, null, 2) + "\n");
  if (input.token !== undefined) {
    const creds = readJson(kp);
    if (input.token === null) delete creds.token;
    else creds.token = input.token;
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
