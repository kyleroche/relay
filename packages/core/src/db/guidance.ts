/**
 * The onboarding gate's tables: providers, models, sources, guidance chunks, and provider-published skills.
 * Full-text search uses the generated `tsv` column with websearch_to_tsquery; vector search uses pgvector cosine.
 */
import { type Db, iso, num, vec } from "./client.ts";

export interface ProviderRow {
  slug: string;
  name: string;
  doc_domains: string[];
  skill_sources: string[];
}
export interface ModelRow {
  id: string;
  provider: string;
  lanes: string[];
  onboarded_at: string | null;
  guidance_count: number | null;
  skill_count: number | null;
  stale_days: number | null;
}
export type GuidanceKind = "prompting" | "limits" | "api" | "moderation" | "style" | "skill";
export interface GuidanceChunk {
  id: string;
  index: number;
  title: string;
  text: string;
  tokens: number;
  kind: GuidanceKind;
}
export interface GuidanceHit {
  id: string;
  title: string;
  kind: GuidanceKind;
  text: string;
  tokens: number;
  source_url: string;
  /** Vector: cosine distance (lower is better). Text: ts_rank (higher is better). */
  score: number;
}
export interface SourceRow {
  url: string;
  provider: string;
  title: string | null;
  sha256: string | null;
  etag: string | null;
  fetched_at: string | null;
  checked_at: string | null;
}
export interface SkillRow {
  name: string;
  model: string;
  provider: string;
  install_path: string;
  version: string;
  sha256: string;
  source_url: string;
}

// ---------- providers & models ----------

/** Domains and skill sources are unioned with what is already stored (the app may have added some). */
export async function upsertProvider(db: Db, p: ProviderRow): Promise<ProviderRow> {
  const r = await db.query<{ doc_domains: string[]; skill_sources: string[] }>(
    `INSERT INTO providers (slug, name, doc_domains, skill_sources) VALUES ($1, $2, $3::text[], $4::text[])
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       doc_domains = (SELECT array_agg(DISTINCT d ORDER BY d) FROM unnest(providers.doc_domains || EXCLUDED.doc_domains) AS d),
       skill_sources = (SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(providers.skill_sources || EXCLUDED.skill_sources) AS s),
       updated_at = now()
     RETURNING doc_domains, skill_sources`,
    [p.slug, p.name, p.doc_domains, p.skill_sources],
  );
  return { slug: p.slug, name: p.name, doc_domains: r[0]?.doc_domains ?? p.doc_domains, skill_sources: r[0]?.skill_sources ?? p.skill_sources };
}

export async function getProvider(db: Db, slug: string): Promise<ProviderRow | undefined> {
  const r = await db.query<ProviderRow>("SELECT slug, name, doc_domains, skill_sources FROM providers WHERE slug = $1", [slug]);
  return r[0];
}

export async function upsertModel(db: Db, m: { id: string; provider: string; lanes: string[]; staleDays: number }): Promise<void> {
  await db.query(
    `INSERT INTO models (id, provider, lanes, stale_days) VALUES ($1, $2, $3::text[], $4)
     ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, lanes = EXCLUDED.lanes, stale_days = EXCLUDED.stale_days, updated_at = now()`,
    [m.id, m.provider, m.lanes, m.staleDays],
  );
}

const toModel = (r: Record<string, unknown>): ModelRow => ({
  id: r.id as string,
  provider: r.provider as string,
  lanes: (r.lanes as string[] | null) ?? [],
  onboarded_at: iso(r.onboarded_at),
  guidance_count: num(r.guidance_count),
  skill_count: num(r.skill_count),
  stale_days: num(r.stale_days),
});
const modelCols = "id, provider, lanes, onboarded_at, guidance_count, skill_count, stale_days";

export async function getModel(db: Db, id: string): Promise<ModelRow | undefined> {
  const r = await db.query(`SELECT ${modelCols} FROM models WHERE id = $1`, [id]);
  return r[0] ? toModel(r[0]) : undefined;
}

export async function listModels(db: Db): Promise<ModelRow[]> {
  return (await db.query(`SELECT ${modelCols} FROM models ORDER BY id`)).map(toModel);
}

export async function markOnboarded(db: Db, id: string, counts: { guidance: number; skills: number }): Promise<void> {
  await db.query("UPDATE models SET onboarded_at = now(), guidance_count = $2, skill_count = $3, updated_at = now() WHERE id = $1", [id, counts.guidance, counts.skills]);
}

// ---------- sources ----------

/** Upsert a source as "checked now"; returns the sha256 stored from the previous fetch (undefined when new). */
export async function touchSource(db: Db, s: { url: string; provider: string; title?: string }): Promise<string | undefined> {
  const r = await db.query<{ prev: string | null }>(
    `WITH prev AS (SELECT sha256 FROM sources WHERE url = $1),
     up AS (
       INSERT INTO sources (url, provider, title, checked_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (url) DO UPDATE SET provider = EXCLUDED.provider, title = coalesce(EXCLUDED.title, sources.title), checked_at = now()
     )
     SELECT sha256 AS prev FROM prev`,
    [s.url, s.provider, s.title ?? null],
  );
  return r[0]?.prev ?? undefined;
}

export async function getSource(db: Db, url: string): Promise<SourceRow | undefined> {
  const r = await db.query("SELECT url, provider, title, sha256, etag, fetched_at, checked_at FROM sources WHERE url = $1", [url]);
  const x = r[0];
  if (!x) return undefined;
  return { url: x.url as string, provider: x.provider as string, title: (x.title as string | null) ?? null, sha256: (x.sha256 as string | null) ?? null, etag: (x.etag as string | null) ?? null, fetched_at: iso(x.fetched_at), checked_at: iso(x.checked_at) };
}

export async function finishSource(db: Db, s: { url: string; sha256: string; etag?: string }): Promise<void> {
  await db.query("UPDATE sources SET sha256 = $2, etag = $3, fetched_at = now() WHERE url = $1", [s.url, s.sha256, s.etag ?? null]);
}

// ---------- guidance chunks ----------

/** Replace every guidance chunk derived from one source for one model. Returns the number stored. */
export async function replaceGuidance(db: Db, args: { modelId: string; provider: string; sourceUrl: string; chunks: GuidanceChunk[] }): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query("DELETE FROM guidance WHERE model = $1 AND source_url = $2", [args.modelId, args.sourceUrl]);
    if (!args.chunks.length) return 0;
    const c = args.chunks;
    const r = await tx.query<{ n: unknown }>(
      `WITH ins AS (
         INSERT INTO guidance (id, model, provider, source_url, chunk_index, kind, title, text, tokens, fetched_at)
         SELECT x.id, $1, $2, $3, x.idx, x.kind, x.title, x.text, x.tokens, now()
         FROM unnest($4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::int[]) AS x(id, idx, kind, title, text, tokens)
         ON CONFLICT (model, id) DO UPDATE SET source_url = EXCLUDED.source_url, chunk_index = EXCLUDED.chunk_index, kind = EXCLUDED.kind,
           title = EXCLUDED.title, text = EXCLUDED.text, tokens = EXCLUDED.tokens, fetched_at = now(), embedding = NULL
         RETURNING 1)
       SELECT count(*) AS n FROM ins`,
      [args.modelId, args.provider, args.sourceUrl, c.map((x) => x.id), c.map((x) => x.index), c.map((x) => x.kind), c.map((x) => x.title), c.map((x) => x.text), c.map((x) => x.tokens)],
    );
    return num(r[0]?.n);
  });
}

/** Drop a model's chunks whose source fell out of the crawl, then any source no chunk references any more. */
export async function pruneGuidance(db: Db, modelId: string, keepUrls: string[]): Promise<number> {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ n: unknown }>(
      `WITH gone AS (DELETE FROM guidance WHERE model = $1 AND NOT (source_url = ANY($2::text[])) RETURNING 1) SELECT count(*) AS n FROM gone`,
      [modelId, keepUrls],
    );
    await tx.query("DELETE FROM sources s WHERE NOT EXISTS (SELECT 1 FROM guidance g WHERE g.source_url = s.url) AND NOT (s.url = ANY($1::text[]))", [keepUrls]);
    return num(r[0]?.n);
  });
}

export async function setEmbeddings(db: Db, items: Array<{ id: string; vec: number[] }>, modelId?: string): Promise<void> {
  const BATCH = 64;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    await db.query(
      `UPDATE guidance g SET embedding = it.v::vector
       FROM unnest($1::text[], $2::text[]) AS it(id, v)
       WHERE g.id = it.id AND ($3::text IS NULL OR g.model = $3)`,
      [slice.map((x) => x.id), slice.map((x) => vec(x.vec)), modelId ?? null],
    );
  }
}

export async function unembeddedGuidance(db: Db, modelId: string): Promise<Array<{ id: string; text: string }>> {
  return db.query<{ id: string; text: string }>("SELECT id, text FROM guidance WHERE model = $1 AND embedding IS NULL ORDER BY source_url, chunk_index", [modelId]);
}

export async function countGuidance(db: Db, modelId: string): Promise<number> {
  const r = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM guidance WHERE model = $1", [modelId]);
  return num(r[0]?.n);
}

const hitCols = "id, title, kind, text, tokens, source_url";
const toHit = (r: Record<string, unknown>): GuidanceHit => ({
  id: r.id as string,
  title: r.title as string,
  kind: r.kind as GuidanceKind,
  text: r.text as string,
  tokens: num(r.tokens),
  source_url: r.source_url as string,
  score: num(r.score),
});

/** Nearest chunks by cosine distance (score = distance, ascending). */
export async function vectorSearchGuidance(db: Db, modelId: string, embedding: number[], k: number): Promise<GuidanceHit[]> {
  const r = await db.query(
    `SELECT ${hitCols}, embedding <=> $2::vector AS score FROM guidance
     WHERE model = $1 AND embedding IS NOT NULL ORDER BY score ASC LIMIT $3`,
    [modelId, vec(embedding), k],
  );
  return r.map(toHit);
}

/**
 * Full-text retrieval over the generated tsv column. websearch_to_tsquery ANDs plain words; when that yields
 * fewer than k hits the remainder is filled by OR-ing the terms, so precise queries stay precise and vague ones
 * still return something.
 */
export async function textSearchGuidance(db: Db, modelId: string, text: string, k: number): Promise<GuidanceHit[]> {
  const terms = Array.from(new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [])).slice(0, 16);
  if (!terms.length) return [];
  const run = (q: string, limit: number) =>
    db.query(
      `SELECT ${hitCols}, ts_rank(tsv, websearch_to_tsquery('english', $2)) AS score FROM guidance
       WHERE model = $1 AND tsv @@ websearch_to_tsquery('english', $2) ORDER BY score DESC, chunk_index LIMIT $3`,
      [modelId, q, limit],
    );
  const strict = (await run(terms.join(" "), k)).map(toHit);
  if (strict.length >= k || terms.length === 1) return strict;
  const seen = new Set(strict.map((h) => h.id));
  const loose = (await run(terms.join(" OR "), k * 2)).map(toHit).filter((h) => !seen.has(h.id));
  return [...strict, ...loose].slice(0, k);
}

// ---------- skills ----------

export async function upsertSkill(db: Db, k: SkillRow): Promise<void> {
  await db.query(
    `INSERT INTO skills (name, model, provider, install_path, version, sha256, source_url, installed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (name, model) DO UPDATE SET provider = EXCLUDED.provider, install_path = EXCLUDED.install_path, version = EXCLUDED.version,
       sha256 = EXCLUDED.sha256, source_url = EXCLUDED.source_url, installed_at = now()`,
    [k.name, k.model, k.provider, k.install_path, k.version, k.sha256, k.source_url],
  );
}

export async function listSkills(db: Db, modelId?: string): Promise<SkillRow[]> {
  const cols = "name, model, provider, install_path, version, sha256, source_url";
  return modelId
    ? db.query<SkillRow>(`SELECT ${cols} FROM skills WHERE model = $1 ORDER BY name`, [modelId])
    : db.query<SkillRow>(`SELECT ${cols} FROM skills ORDER BY model, name`);
}
