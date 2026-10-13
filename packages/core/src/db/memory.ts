/** Durable cross-tool memory: decisions with validity windows, and preferences by scope. */
import { type Db, iso, num, vec } from "./client.ts";

export interface DecisionRow {
  id: number;
  project: string | null;
  text: string;
  source: string | null;
  source_ref: string | null;
  valid_from: string;
  valid_to: string | null;
  superseded_by: number | null;
  created_at: string;
}
export interface DecisionHit extends DecisionRow {
  /** Vector: cosine distance (lower is better). Text: ts_rank (higher is better). */
  score: number;
}
export interface PreferenceRow {
  key: string;
  value: string;
  scope: "global" | "project" | "lane" | "model";
  scope_id: string | null;
  reason: string | null;
}

const decisionCols = "id, project, text, source, source_ref, valid_from, valid_to, superseded_by, created_at";
const toDecision = (r: Record<string, unknown>): DecisionRow => ({
  id: num(r.id),
  project: (r.project as string | null) ?? null,
  text: r.text as string,
  source: (r.source as string | null) ?? null,
  source_ref: (r.source_ref as string | null) ?? null,
  valid_from: iso(r.valid_from) ?? "",
  valid_to: iso(r.valid_to),
  superseded_by: r.superseded_by == null ? null : num(r.superseded_by),
  created_at: iso(r.created_at) ?? "",
});

export async function addDecision(db: Db, d: { project?: string | null; text: string; source?: string; sourceRef?: string; embedding?: number[] }): Promise<DecisionRow> {
  const r = await db.query(
    `INSERT INTO decisions (project, text, source, source_ref, embedding) VALUES ($1, $2, $3, $4, $5::vector) RETURNING ${decisionCols}`,
    [d.project ?? null, d.text, d.source ?? null, d.sourceRef ?? null, d.embedding ? vec(d.embedding) : null],
  );
  return toDecision(r[0]!);
}

/** Close the old decision's validity window and record a replacement. Returns the new row. */
export async function supersedeDecision(db: Db, oldId: number, replacement: { text: string; source?: string; sourceRef?: string; embedding?: number[] }): Promise<DecisionRow> {
  return db.transaction(async (tx) => {
    const old = await tx.query<{ project: string | null }>("SELECT project FROM decisions WHERE id = $1", [oldId]);
    if (!old[0]) throw new Error(`decision ${oldId} not found`);
    const next = await addDecision(tx, { project: old[0].project, ...replacement });
    await tx.query("UPDATE decisions SET valid_to = now(), superseded_by = $2 WHERE id = $1 AND valid_to IS NULL", [oldId, next.id]);
    return next;
  });
}

export async function listDecisions(db: Db, project: string | null | undefined, opts: { current?: boolean; limit?: number } = {}): Promise<DecisionRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (project !== undefined) {
    if (project === null) where.push("project IS NULL");
    else {
      params.push(project);
      where.push(`project = $${params.length}`);
    }
  }
  if (opts.current) where.push("valid_to IS NULL");
  params.push(opts.limit ?? 200);
  const r = await db.query(
    `SELECT ${decisionCols} FROM decisions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY valid_from DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return r.map(toDecision);
}

/** Current decisions for a project, by vector (number[]) or full-text (string) similarity. */
export async function searchDecisions(db: Db, project: string | null | undefined, query: string | number[], k = 8): Promise<DecisionHit[]> {
  const params: unknown[] = [];
  const scope = project === undefined ? "" : project === null ? "AND project IS NULL" : (params.push(project), `AND project = $${params.length}`);
  if (typeof query === "string") {
    params.push(query, k);
    const r = await db.query(
      `SELECT ${decisionCols}, ts_rank(tsv, websearch_to_tsquery('english', $${params.length - 1})) AS score FROM decisions
       WHERE valid_to IS NULL ${scope} AND tsv @@ websearch_to_tsquery('english', $${params.length - 1})
       ORDER BY score DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return r.map((x) => ({ ...toDecision(x), score: num(x.score) }));
  }
  params.push(vec(query), k);
  const r = await db.query(
    `SELECT ${decisionCols}, embedding <=> $${params.length - 1}::vector AS score FROM decisions
     WHERE valid_to IS NULL ${scope} AND embedding IS NOT NULL ORDER BY score ASC LIMIT $${params.length}`,
    params,
  );
  return r.map((x) => ({ ...toDecision(x), score: num(x.score) }));
}

export async function upsertPreference(db: Db, p: PreferenceRow): Promise<void> {
  await db.query(
    `INSERT INTO preferences (key, scope, scope_id, value, reason) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key, scope, scope_id) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, updated_at = now()`,
    [p.key, p.scope, p.scope_id ?? "", p.value, p.reason ?? null],
  );
}

export async function listPreferences(db: Db, scope?: PreferenceRow["scope"], scopeId?: string): Promise<PreferenceRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope) {
    params.push(scope);
    where.push(`scope = $${params.length}`);
    if (scopeId) {
      params.push(scopeId);
      where.push(`scope_id = $${params.length}`);
    }
  }
  const r = await db.query<{ key: string; value: string; scope: PreferenceRow["scope"]; scope_id: string; reason: string | null }>(
    `SELECT key, value, scope, scope_id, reason FROM preferences ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY key, scope, scope_id`,
    params,
  );
  return r.map((x) => ({ ...x, scope_id: x.scope_id === "" ? null : x.scope_id }));
}
