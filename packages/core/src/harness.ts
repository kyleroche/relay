import { loadConfig, ensureHome, type HarnessConfig } from "./config.ts";
import { openDb, type Db } from "./db/client.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { Harness } from "./onboard/index.ts";
import { briefEmbedder } from "./brief/index.ts";
import { credentialsFromToken, OAuthClientError, refreshAccessToken, tokenIsStale } from "./client/device.ts";
import { httpClient, SiteModeError } from "./client/http.ts";
import { localClient } from "./client/local.ts";
import { writeSiteConfig } from "./client/site.ts";
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
  try {
    const r = await refreshAccessToken({ site: cfg.site, refreshToken: cfg.siteRefreshToken });
    const c = credentialsFromToken(r, now);
    writeSiteConfig({ site: cfg.site, token: { token: c.token, refreshToken: c.refreshToken, expiresAt: c.expiresAt, source: cfg.siteTokenSource ?? "device", tokenName: r.token_name ?? cfg.siteTokenName ?? null } }, cfg.home);
    const next: HarnessConfig = { ...cfg, siteToken: c.token };
    if (c.refreshToken) next.siteRefreshToken = c.refreshToken;
    if (c.expiresAt) next.siteTokenExpiresAt = c.expiresAt;
    if (r.token_name) next.siteTokenName = r.token_name;
    return next;
  } catch (e) {
    const why = e instanceof OAuthClientError ? `${e.code}: ${e.description}` : e instanceof Error ? e.message : String(e);
    throw new SiteModeError("refreshing the site token", `the refresh failed (${why}); run \`relay setup --site ${cfg.site}\` to approve this machine again`);
  }
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
