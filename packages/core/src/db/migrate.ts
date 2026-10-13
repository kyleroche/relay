/**
 * Plain-SQL migrations: packages/core/src/db/migrations/NNN_name.sql, applied in order inside one transaction
 * each, tracked in meta.schema_version. Running twice is a no-op. Never edit a shipped migration; add a new file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "./client.ts";
import { type Log, noopLog } from "../util.ts";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^(\d{3,})_([\w-]+)\.sql$/.exec(f);
    if (!m) continue;
    out.push({ version: Number(m[1]), name: m[2]!, sql: readFileSync(join(dir, f), "utf8") });
  }
  const seen = new Set<number>();
  for (const m of out) {
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return out;
}

const META_DDL = `CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export async function currentVersion(db: Db): Promise<number> {
  await db.exec(META_DDL);
  const r = await db.query<{ value: unknown }>("SELECT value FROM meta WHERE key = 'schema_version'");
  const v = r[0]?.value;
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0;
}

export async function migrate(db: Db, opts: { log?: Log; dir?: string } = {}): Promise<number> {
  const log = opts.log ?? noopLog;
  const have = await currentVersion(db);
  let applied = have;
  for (const m of loadMigrations(opts.dir)) {
    if (m.version <= have) continue;
    log(`schema: applying ${String(m.version).padStart(3, "0")}_${m.name}`);
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query(
        `INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(m.version)],
      );
    });
    applied = m.version;
  }
  return applied;
}
