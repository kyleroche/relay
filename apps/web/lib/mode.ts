/**
 * Deployment mode flags read from the environment. Kept free of imports so `proxy.ts` (which runs before any
 * page) and the tests can use them without loading the data adapters.
 *
 * Mode selection (`dataMode`):
 *   RELAY_DATA=mock            -> lib/data-mock.ts, whatever else is set
 *   RELAY_DATA=db              -> lib/data-db.ts over DATABASE_URL, or the embedded PGlite file when it is unset
 *   neither                    -> db when DATABASE_URL is set, else mock
 */
export type DataMode = "mock" | "db";

/** `process.env` or a test's stand-in. */
export type Env = Record<string, string | undefined>;

export function dataMode(env: Env = process.env): DataMode {
  const explicit = env.RELAY_DATA;
  if (explicit === "db") return "db";
  if (explicit === "mock") return "mock";
  return env.DATABASE_URL ? "db" : "mock";
}

/** True when unauthenticated reads of /api/v1/* are allowed. Defaults on in mock mode. */
export function publicReadEnabled(env: Env = process.env): boolean {
  const v = env.RELAY_PUBLIC_READ;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return dataMode(env) === "mock";
}
