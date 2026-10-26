import { loadConfig, ensureHome, type HarnessConfig } from "./config.ts";
import { openDb, type Db } from "./db/client.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { Harness } from "./onboard/index.ts";
import { briefEmbedder } from "./brief/index.ts";
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { credentialsFromToken, OAuthClientError, refreshAccessToken, tokenIsStale } from "./client/device.ts";
import { type HttpFetch, httpClient, SiteModeError } from "./client/http.ts";
import { localClient } from "./client/local.ts";
import { credentialsPath, readSiteConfig, writeSiteConfig } from "./client/site.ts";
import type { ClientMode, RelayClient } from "./client/types.ts";

export interface OpenHarness extends Harness {
  cfg: HarnessConfig;
  /** The database. In site mode without `local: true` this handle throws SiteModeError on use. */
  db: Db;
  ledger: Ledger;
  /** The command surface: local (over `db`) or site (over the hosted API). */
  client: RelayClient;
  mode: ClientMode;
  close(): Promise<void>;
}

export interface OpenHarnessOptions {
  /** Open the local database even when a site is configured (`relay link` digests locally, then uploads). */
  local?: boolean;
  /** Attribution for writes made through the client (default `human:<user>`). */
  actor?: string;
}

/** A Db that refuses every call: what `h.db` is in site mode, so a command that still needs SQL fails with one clear line. */
export function siteModeDb(site: string): Db {
  const refuse = (): never => {
    throw new SiteModeError("direct database access", `this CLI talks to ${site}; run the command on the machine that holds the database or remove the site with \`relay setup --no-site\``);
  };
  return { driver: "pglite", query: async () => refuse(), exec: async () => refuse(), transaction: async () => refuse(), close: async () => {} };
}

export const defaultActor = (): string => `human:${process.env.RELAY_ACTOR ?? process.env.USER ?? "local"}`;

/**
 * Open the harness. With a site configured (`relay setup --site`), `client` talks to it over HTTPS and no database is
 * opened unless `local` is set; otherwise `client` wraps the database (Postgres via DATABASE_URL, else embedded PGlite).
 */
/**
 * A site token from the device flow or an invite lives 24 hours; its refresh token lives 90 days. When the access
 * token is about to lapse, trade the refresh token for a new pair and store it, so hooks and commands never see a 401.
 * A failed refresh (revoked, expired, reused) says what to do instead of failing on the first call.
 */
export async function refreshSiteTokenIfStale(cfg: HarnessConfig, now: number = Date.now()): Promise<HarnessConfig> {
  if (!cfg.site || !cfg.siteToken || !cfg.siteRefreshToken || !tokenIsStale(cfg.siteTokenExpiresAt, now)) return cfg;
  if (cfg.siteTokenSource === "env") return cfg;
  return refreshSiteToken(cfg, now);
}

/** True when the credential can be renewed from here: a refresh token from the device flow or an invite, not RELAY_TOKEN. */
export const canRefreshSiteToken = (cfg: HarnessConfig): boolean => !!cfg.site && !!cfg.siteRefreshToken && cfg.siteTokenSource !== "env";

/**
 * Serialise refreshes across the processes that share one credential file (CLI commands, hooks, the stdio MCP bridge,
 * a worker): a refresh rotates the refresh token, and the server treats a second use of the old one as a leaked chain
 * and revokes every token on it. The lock is a file next to credentials.json created exclusively; a lock older than
 * `STALE_LOCK_MS` is from a process that died and is taken over. Waiting longer than `LOCK_WAIT_MS` proceeds anyway.
 */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
async function withCredentialLock<T>(home: string | undefined, fn: () => Promise<T>): Promise<T> {
  const lock = `${credentialsPath(home)}.lock`;
  const started = Date.now();
  let held = false;
  while (!held) {
    try {
      writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break; // no lock possible here (read-only home): refresh unguarded
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // vanished between the two calls: try again
      }
      if (age > STALE_LOCK_MS) {
        try {
          unlinkSync(lock);
        } catch {
          // another waiter took it over first
        }
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }
}

/** The config with whatever credential the file holds now, when another process stored a newer one than `cfg` carries. */
function adoptStored(cfg: HarnessConfig, now: number): HarnessConfig | undefined {
  const stored = readSiteConfig(cfg.home);
  if (!stored.token || stored.tokenSource === "env" || stored.site !== cfg.site) return undefined;
  if (stored.token === cfg.siteToken || tokenIsStale(stored.tokenExpiresAt, now)) return undefined;
  const next: HarnessConfig = { ...cfg, siteToken: stored.token };
  if (stored.refreshToken) next.siteRefreshToken = stored.refreshToken;
  if (stored.tokenExpiresAt) next.siteTokenExpiresAt = stored.tokenExpiresAt;
  if (stored.tokenName) next.siteTokenName = stored.tokenName;
  return next;
}

/**
 * Trade the refresh token for a new pair now, whatever the expiry says (the site answered 401 to a token that
 * looked valid: revoked, or rotated by another process). Stores the new credential and returns the config with it.
 * Under the credential lock, and only after re-reading the file: when another process renewed the credential first,
 * its pair is adopted and nothing is sent, so two refreshers never spend the same refresh token.
 */
export async function refreshSiteToken(cfg: HarnessConfig, now: number = Date.now(), deps: { fetch?: HttpFetch } = {}): Promise<HarnessConfig> {
  if (!cfg.site || !cfg.siteRefreshToken) throw new SiteModeError("refreshing the site token", `no refresh token is stored; run \`relay setup --site ${cfg.site ?? "<url>"}\` to approve this machine again`);
  const site = cfg.site;
  return withCredentialLock(cfg.home, async () => {
    const fresh = adoptStored(cfg, now);
    if (fresh) return fresh;
    // the file may hold a rotated refresh token from a renewal that was then revoked server-side; prefer the stored one
    const stored = readSiteConfig(cfg.home);
    const refreshToken = stored.site === site && stored.refreshToken && stored.tokenSource !== "env" ? stored.refreshToken : cfg.siteRefreshToken!;
    try {
      const r = await refreshAccessToken({ site, refreshToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const c = credentialsFromToken(r, now);
      writeSiteConfig({ site, token: { token: c.token, refreshToken: c.refreshToken, expiresAt: c.expiresAt, source: cfg.siteTokenSource ?? "device", tokenName: r.token_name ?? cfg.siteTokenName ?? null } }, cfg.home);
      const next: HarnessConfig = { ...cfg, siteToken: c.token };
      if (c.refreshToken) next.siteRefreshToken = c.refreshToken;
      if (c.expiresAt) next.siteTokenExpiresAt = c.expiresAt;
      if (r.token_name) next.siteTokenName = r.token_name;
      return next;
    } catch (e) {
      const late = adoptStored(cfg, now); // a renewal that landed while we were refused
      if (late) return late;
      const why = e instanceof OAuthClientError ? `${e.code}: ${e.description}` : e instanceof Error ? e.message : String(e);
      throw new SiteModeError("refreshing the site token", `the refresh failed (${why}); run \`relay setup --site ${site}\` to approve this machine again`);
    }
  });
}

export async function openHarness(cfg: HarnessConfig = loadConfig(), opts: OpenHarnessOptions = {}): Promise<OpenHarness> {
  ensureHome(cfg);
  const actor = opts.actor ?? defaultActor();
  cfg = await refreshSiteTokenIfStale(cfg);
  const siteMode = !!cfg.site && !!cfg.siteToken;
  const db = siteMode && !opts.local ? siteModeDb(cfg.site!) : await openDb(cfg.databaseUrl ? { url: cfg.databaseUrl } : { file: cfg.dbFile });
  const ledger = new Ledger(db);
  const client: RelayClient = siteMode ? httpClient({ site: cfg.site!, token: cfg.siteToken!, actor }) : localClient(db, { actor, embed: briefEmbedder({ cfg, ledger }), ...(cfg.site ? { installUrl: `${cfg.site}/setup/github` } : {}) });
  return {
    cfg,
    db,
    ledger,
    client,
    mode: siteMode ? "site" : "local",
    async close() {
      await client.close();
      await db.close();
    },
  };
}
