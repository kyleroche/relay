/**
 * One database handle per server instance. Fluid compute (and the dev server's HMR) reuse module instances, so the
 * handle lives on globalThis and is opened once; migrations run on first use so a fresh Neon database or PGlite file
 * works without a separate `relay init`.
 *
 * DATABASE_URL selects Postgres. Without it (RELAY_DATA=db locally) the embedded PGlite file is used: RELAY_PGLITE_FILE,
 * else @relay/core's default under $RELAY_HOME (~/.harness/relay.pglite), the same file the CLI writes.
 */
import { DEFAULT_PGLITE_FILE, migrate, openDb, type Db } from "@relay/core";

declare global {
  // eslint-disable-next-line no-var
  var __relayDb: Promise<Db> | undefined;
  // eslint-disable-next-line no-var
  var __relayMemoryDb: Promise<Db> | undefined;
}

/** An empty in-memory PGlite, migrated: what the MCP memory tools run against in mock mode. */
export function getMemoryDb(): Promise<Db> {
  if (!globalThis.__relayMemoryDb) {
    globalThis.__relayMemoryDb = (async () => {
      const db = await openDb({ file: ":memory:" });
      await migrate(db);
      return db;
    })().catch((e: unknown) => {
      globalThis.__relayMemoryDb = undefined;
      throw e;
    });
  }
  return globalThis.__relayMemoryDb;
}

export function pgliteFile(): string {
  return process.env.RELAY_PGLITE_FILE || DEFAULT_PGLITE_FILE;
}

/** Where reads and writes go, for the info document and logs. */
export function dbTarget(): string {
  return process.env.DATABASE_URL ? "postgres (DATABASE_URL)" : `pglite (${pgliteFile()})`;
}

export function getDb(): Promise<Db> {
  if (!globalThis.__relayDb) {
    globalThis.__relayDb = (async () => {
      const url = process.env.DATABASE_URL;
      const db = await openDb(url ? { url } : { file: pgliteFile() });
      await migrate(db);
      return db;
    })().catch((e: unknown) => {
      // let the next request retry instead of caching a failed open
      globalThis.__relayDb = undefined;
      throw e;
    });
  }
  return globalThis.__relayDb;
}
