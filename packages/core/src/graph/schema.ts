import type { GraphClient } from "./client.ts";
import type { Log } from "../util.ts";
import { noopLog, nowIso } from "../util.ts";

/**
 * Schema migrations for the `harness` graph. Each version is a list of statements; errors that only say
 * "already exists/indexed" are tolerated so re-running is safe. Uniqueness is enforced by MERGE discipline in
 * repo.ts rather than GRAPH.CONSTRAINT (which is a redis command, not Cypher, so it cannot run over MCP).
 */
export const migrations: Array<{ version: number; statements: (opts: { dim: number }) => string[] }> = [
  {
    version: 1,
    statements: ({ dim }) => [
      "CREATE INDEX FOR (p:Project) ON (p.slug)",
      "CREATE INDEX FOR (f:FileDigest) ON (f.path)",
      "CREATE INDEX FOR (t:Task) ON (t.id)",
      "CREATE INDEX FOR (s:Step) ON (s.id)",
      "CREATE INDEX FOR (p:Provider) ON (p.slug)",
      "CREATE INDEX FOR (m:Model) ON (m.id)",
      "CREATE INDEX FOR (g:Guidance) ON (g.id)",
      "CREATE INDEX FOR (g:Guidance) ON (g.model)",
      "CREATE INDEX FOR (s:Source) ON (s.url)",
      "CREATE INDEX FOR (k:Skill) ON (k.name)",
      "CREATE INDEX FOR (p:Preference) ON (p.key)",
      `CREATE VECTOR INDEX FOR (g:Guidance) ON (g.embedding) OPTIONS {dimension: ${dim}, similarityFunction: 'cosine'}`,
      "CALL db.idx.fulltext.createNodeIndex('Guidance', 'text', 'title')",
    ],
  },
];

export async function currentVersion(g: GraphClient): Promise<number> {
  const r = await g.query<{ v: number | null }>("MATCH (m:Meta {key:'schema'}) RETURN m.version AS v", {}, { readOnly: true });
  return r.rows[0]?.v ?? 0;
}

export async function migrate(g: GraphClient, opts: { dim: number; log?: Log }): Promise<number> {
  const log = opts.log ?? noopLog;
  const have = await currentVersion(g);
  let applied = have;
  for (const m of migrations) {
    if (m.version <= have) continue;
    log(`schema: applying v${m.version}`);
    for (const st of m.statements({ dim: opts.dim })) {
      try {
        await g.query(st);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already/i.test(msg)) continue;
        throw e;
      }
    }
    await g.query("MERGE (m:Meta {key:'schema'}) SET m.version = $v, m.updated_at = $now", { v: m.version, now: nowIso() });
    applied = m.version;
  }
  return applied;
}
