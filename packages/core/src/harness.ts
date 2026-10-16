import { loadConfig, ensureHome, type HarnessConfig } from "./config.ts";
import { openDb, type Db } from "./db/client.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { Harness } from "./onboard/index.ts";
import { briefEmbedder } from "./brief/index.ts";
import { httpClient, SiteModeError } from "./client/http.ts";
import { localClient } from "./client/local.ts";
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
export async function openHarness(cfg: HarnessConfig = loadConfig(), opts: OpenHarnessOptions = {}): Promise<OpenHarness> {
  ensureHome(cfg);
  const actor = opts.actor ?? defaultActor();
  const siteMode = !!cfg.site && !!cfg.siteToken;
  const db = siteMode && !opts.local ? siteModeDb(cfg.site!) : await openDb(cfg.databaseUrl ? { url: cfg.databaseUrl } : { file: cfg.dbFile });
  const ledger = new Ledger(db);
  const client: RelayClient = siteMode ? httpClient({ site: cfg.site!, token: cfg.siteToken!, actor }) : localClient(db, { actor, embed: briefEmbedder({ cfg, ledger }) });
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
