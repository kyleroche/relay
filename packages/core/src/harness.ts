import { loadConfig, ensureHome, type HarnessConfig } from "./config.ts";
import { openDb, type Db } from "./db/client.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { Harness } from "./onboard/index.ts";

export interface OpenHarness extends Harness {
  cfg: HarnessConfig;
  db: Db;
  ledger: Ledger;
  close(): Promise<void>;
}

/** Open the database (Postgres via DATABASE_URL, else embedded PGlite) and the ledger adapter over it. */
export async function openHarness(cfg: HarnessConfig = loadConfig()): Promise<OpenHarness> {
  ensureHome(cfg);
  const db = await openDb(cfg.databaseUrl ? { url: cfg.databaseUrl } : { file: cfg.dbFile });
  const ledger = new Ledger(db);
  return {
    cfg,
    db,
    ledger,
    async close() {
      await db.close();
    },
  };
}
