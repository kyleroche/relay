/**
 * One Postgres interface over two drivers. `DATABASE_URL` (or opts.url) selects `pg` over TCP (Neon in
 * production); otherwise an embedded PGlite with pgvector persists under ~/.harness/relay.pglite
 * (`:memory:` for tests). Placeholders are `$1..$n` for both. Driver differences that leak through the
 * row shape (int8 as string vs number, timestamptz as Date) are normalised by the helpers at the bottom.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Db {
  readonly driver: "pg" | "pglite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs fn inside BEGIN/COMMIT; the handle passed in must be used for every statement in the transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  /** Postgres connection string; defaults to process.env.DATABASE_URL. */
  url?: string;
  /** PGlite data directory; defaults to ~/.harness/relay.pglite (RELAY_HOME honoured). ':memory:' for tests. */
  file?: string;
}

export const DEFAULT_PGLITE_FILE = join(process.env.RELAY_HOME ?? join(homedir(), ".harness"), "relay.pglite");

export class DbError extends Error {
  constructor(message: string, readonly sql: string) {
    super(message);
    this.name = "DbError";
  }
}

function wrap<T>(sql: string, p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    throw new DbError(e instanceof Error ? e.message : String(e), sql);
  });
}

// ---------- pg (TCP) ----------

type PgPool = import("pg").Pool;
type PgClient = import("pg").PoolClient;

function pgQueryable(q: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, nested: () => Db["transaction"]): Pick<Db, "query" | "exec" | "transaction"> {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await wrap(sql, q.query(sql, params));
      return r.rows as T[];
    },
    async exec(sql: string) {
      await wrap(sql, q.query(sql));
    },
    transaction: (fn) => nested()(fn),
  };
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool: PgPool = new pg.Pool({ connectionString: url, max: 4 });
  // Sanity check the connection up front so a bad URL fails at open time, not on the first query.
  await wrap("SELECT 1", pool.query("SELECT 1"));

  const txOn = (client: PgClient): Db => {
    const inner: Db = {
      driver: "pg",
      ...pgQueryable(client, () => async (fn) => fn(inner)), // nested transaction = same connection, no savepoint
      close: async () => {},
    };
    return inner;
  };

  const db: Db = {
    driver: "pg",
    ...pgQueryable(pool, () => async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(txOn(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }),
    close: () => pool.end(),
  };
  return db;
}

// ---------- PGlite (embedded) ----------

type PGliteLike = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; exec(sql: string): Promise<unknown> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

async function openPglite(file: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const memory = file === ":memory:";
  if (!memory) mkdirSync(dirname(file), { recursive: true });
  const pg = (await PGlite.create({ dataDir: memory ? "memory://" : file, extensions: { vector } })) as unknown as PGliteLike;

  const over = (q: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; exec(sql: string): Promise<unknown> }, transaction: Db["transaction"]): Db => ({
    driver: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await wrap(sql, q.query<T>(sql, params));
      return r.rows;
    },
    async exec(sql: string) {
      await wrap(sql, q.exec(sql));
    },
    transaction,
    close: async () => {},
  });

  const db = over(pg, (fn) =>
    pg.transaction(async (tx) => {
      const inner = over(tx, async (f) => f(inner));
      return fn(inner);
    }),
  );
  return { ...db, close: () => pg.close() };
}

// ---------- entry ----------

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) return openPg(url);
  return openPglite(opts.file ?? DEFAULT_PGLITE_FILE);
}

// ---------- row normalisers (driver differences) ----------

/** int8/numeric arrive as strings from pg and (numeric) PGlite; aggregates always go through here. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v));
/** timestamptz arrives as a Date from both drivers; the public row shapes use ISO strings. */
export const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
/** pgvector literal for a `$n::vector` parameter. */
export const vec = (v: number[]): string => `[${v.join(",")}]`;
