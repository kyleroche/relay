import type { GraphClient } from "./client.ts";
import { nowIso } from "../util.ts";

/** Typed access to the harness graph. Every writer uses MERGE on a natural key so re-runs are idempotent. */

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
  score: number;
}

export async function upsertProvider(g: GraphClient, p: ProviderRow): Promise<ProviderRow> {
  // union domains/skill sources with whatever is already in the graph (the app may have added some)
  const r = await g.query<{ domains: string[] | null; skills: string[] | null }>(
    `MERGE (p:Provider {slug:$slug})
     ON CREATE SET p.created_at = $now
     SET p.name = $name, p.updated_at = $now
     RETURN p.doc_domains AS domains, p.skill_sources AS skills`,
    { slug: p.slug, name: p.name, now: nowIso() },
  );
  const domains = Array.from(new Set([...(r.rows[0]?.domains ?? []), ...p.doc_domains]));
  const skills = Array.from(new Set([...(r.rows[0]?.skills ?? []), ...p.skill_sources]));
  await g.query("MATCH (p:Provider {slug:$slug}) SET p.doc_domains = $domains, p.skill_sources = $skills", {
    slug: p.slug,
    domains,
    skills,
  });
  return { ...p, doc_domains: domains, skill_sources: skills };
}

export async function getProvider(g: GraphClient, slug: string): Promise<ProviderRow | undefined> {
  const r = await g.query<{ p: { properties: ProviderRow } }>("MATCH (p:Provider {slug:$slug}) RETURN p", { slug }, { readOnly: true });
  const props = r.rows[0]?.p?.properties;
  return props ? { ...props, doc_domains: props.doc_domains ?? [], skill_sources: props.skill_sources ?? [] } : undefined;
}

export async function upsertModel(g: GraphClient, m: { id: string; provider: string; lanes: string[]; staleDays: number }): Promise<void> {
  await g.query(
    `MERGE (m:Model {id:$id})
     ON CREATE SET m.created_at = $now, m.onboarded_at = null, m.guidance_count = 0, m.skill_count = 0
     SET m.provider = $provider, m.lanes = $lanes, m.stale_days = $stale, m.updated_at = $now
     WITH m
     MATCH (p:Provider {slug:$provider})
     MERGE (p)-[:PUBLISHES]->(m)`,
    { id: m.id, provider: m.provider, lanes: m.lanes, stale: m.staleDays, now: nowIso() },
  );
}

export async function getModel(g: GraphClient, id: string): Promise<ModelRow | undefined> {
  const r = await g.query<{ m: { properties: ModelRow } }>("MATCH (m:Model {id:$id}) RETURN m", { id }, { readOnly: true });
  return r.rows[0]?.m?.properties;
}

export async function listModels(g: GraphClient): Promise<ModelRow[]> {
  const r = await g.query<{ m: { properties: ModelRow } }>("MATCH (m:Model) RETURN m ORDER BY m.id", {}, { readOnly: true });
  return r.rows.map((x) => x.m.properties);
}

export async function markOnboarded(g: GraphClient, id: string, counts: { guidance: number; skills: number }): Promise<void> {
  await g.query(
    "MATCH (m:Model {id:$id}) SET m.onboarded_at = $now, m.guidance_count = $gc, m.skill_count = $sc",
    { id, now: nowIso(), gc: counts.guidance, sc: counts.skills },
  );
}

/** Returns the previously stored sha256 for a Source (undefined when new). */
export async function touchSource(g: GraphClient, s: { url: string; provider: string; title?: string }): Promise<string | undefined> {
  const r = await g.query<{ prev: string | null }>(
    `MERGE (s:Source {url:$url})
     ON CREATE SET s.created_at = $now, s.official = true
     SET s.provider = $provider, s.title = coalesce($title, s.title), s.checked_at = $now
     RETURN s.sha256 AS prev`,
    { url: s.url, provider: s.provider, title: s.title ?? null, now: nowIso() },
  );
  return r.rows[0]?.prev ?? undefined;
}

export async function getSource(g: GraphClient, url: string): Promise<{ url: string; sha256: string | null; title: string | null } | undefined> {
  const r = await g.query<{ url: string; sha256: string | null; title: string | null }>(
    "MATCH (s:Source {url:$url}) RETURN s.url AS url, s.sha256 AS sha256, s.title AS title",
    { url },
    { readOnly: true },
  );
  return r.rows[0];
}

export async function finishSource(g: GraphClient, s: { url: string; sha256: string; etag?: string }): Promise<void> {
  await g.query("MATCH (s:Source {url:$url}) SET s.sha256 = $sha, s.etag = $etag, s.fetched_at = $now", {
    url: s.url,
    sha: s.sha256,
    etag: s.etag ?? null,
    now: nowIso(),
  });
}

/** Replace every Guidance chunk derived from one Source for one Model. */
export async function replaceGuidance(
  g: GraphClient,
  args: { modelId: string; provider: string; sourceUrl: string; chunks: GuidanceChunk[] },
): Promise<number> {
  await g.query("MATCH (s:Source {url:$url})<-[:FROM]-(x:Guidance {model:$model}) DETACH DELETE x", {
    url: args.sourceUrl,
    model: args.modelId,
  });
  if (!args.chunks.length) return 0;
  const r = await g.query<{ n: number }>(
    `MATCH (m:Model {id:$model}), (s:Source {url:$url})
     UNWIND $chunks AS c
     CREATE (x:Guidance {id:c.id, model:$model, provider:$provider, kind:c.kind, title:c.title, text:c.text,
                         tokens:c.tokens, source_url:$url, chunk_index:c.index, fetched_at:$now, embedded:false})
     CREATE (m)-[:GUIDED_BY]->(x)
     CREATE (x)-[:FROM]->(s)
     RETURN count(x) AS n`,
    { model: args.modelId, provider: args.provider, url: args.sourceUrl, chunks: args.chunks, now: nowIso() },
  );
  return r.rows[0]?.n ?? 0;
}

/** Remove guidance for a model whose source is no longer part of the crawl, then drop orphaned Sources. */
export async function pruneGuidance(g: GraphClient, modelId: string, keepUrls: string[]): Promise<number> {
  const r = await g.query<{ n: number }>(
    "MATCH (x:Guidance {model:$model}) WHERE NOT x.source_url IN $keep WITH x, count(x) AS n DETACH DELETE x RETURN sum(n) AS n",
    { model: modelId, keep: keepUrls },
  );
  await g.query("MATCH (s:Source) WHERE NOT (s)<-[:FROM]-() DETACH DELETE s");
  return r.rows[0]?.n ?? 0;
}

export async function setEmbeddings(g: GraphClient, items: Array<{ id: string; vec: number[] }>): Promise<void> {
  const BATCH = 16;
  for (let i = 0; i < items.length; i += BATCH) {
    await g.query(
      "UNWIND $items AS it MATCH (x:Guidance {id: it.id}) SET x.embedding = vecf32(it.vec), x.embedded = true",
      { items: items.slice(i, i + BATCH) },
    );
  }
}

export async function unembeddedGuidance(g: GraphClient, modelId: string): Promise<Array<{ id: string; text: string }>> {
  const r = await g.query<{ id: string; text: string }>(
    "MATCH (x:Guidance {model:$model}) WHERE x.embedded = false RETURN x.id AS id, x.text AS text",
    { model: modelId },
    { readOnly: true },
  );
  return r.rows;
}

export async function countGuidance(g: GraphClient, modelId: string): Promise<number> {
  const r = await g.query<{ n: number }>("MATCH (x:Guidance {model:$model}) RETURN count(x) AS n", { model: modelId }, { readOnly: true });
  return r.rows[0]?.n ?? 0;
}

const hitFields = "x.id AS id, x.title AS title, x.kind AS kind, x.text AS text, x.tokens AS tokens, x.source_url AS source_url";

export async function vectorSearchGuidance(g: GraphClient, modelId: string, vec: number[], k: number): Promise<GuidanceHit[]> {
  const r = await g.query<GuidanceHit>(
    `CALL db.idx.vector.queryNodes('Guidance', 'embedding', ${Math.max(k * 4, 20)}, vecf32($vec)) YIELD node AS x, score
     WHERE x.model = $model
     RETURN ${hitFields}, score ORDER BY score ASC LIMIT ${k}`,
    { vec, model: modelId },
    { readOnly: true },
  );
  return r.rows;
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "into", "your", "you", "all", "any", "can", "not", "use", "using", "how", "what", "when", "where", "which", "should", "will", "than", "then", "them", "they", "its", "our", "one", "two"]);

/**
 * Full-text retrieval (RediSearch syntax). First pass requires every term (AND); when that yields fewer than k hits
 * the remainder is filled from an any-term (OR) pass. Keeps precise queries precise without starving vague ones.
 */
export async function textSearchGuidance(g: GraphClient, modelId: string, text: string, k: number): Promise<GuidanceHit[]> {
  const terms = Array.from(new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])).filter((t) => !STOP.has(t)).slice(0, 16);
  if (!terms.length) return [];
  const run = async (q: string, limit: number) =>
    (
      await g.query<GuidanceHit>(
        `CALL db.idx.fulltext.queryNodes('Guidance', $q) YIELD node AS x, score
         WHERE x.model = $model
         RETURN ${hitFields}, score ORDER BY score DESC LIMIT ${limit}`,
        { q, model: modelId },
        { readOnly: true },
      )
    ).rows;
  const strict = terms.length > 1 ? await run(terms.join(" "), k) : [];
  if (strict.length >= k) return strict;
  const seen = new Set(strict.map((h) => h.id));
  const loose = (await run(terms.join("|"), k * 2)).filter((h) => !seen.has(h.id));
  return [...strict, ...loose].slice(0, k);
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
export async function upsertSkill(g: GraphClient, k: SkillRow): Promise<void> {
  await g.query(
    `MERGE (k:Skill {name:$name, model:$model})
     ON CREATE SET k.created_at = $now
     SET k.provider = $provider, k.install_path = $path, k.version = $version, k.sha256 = $sha, k.source_url = $src, k.installed_at = $now
     WITH k
     MATCH (p:Provider {slug:$provider}), (m:Model {id:$model})
     MERGE (p)-[:SHIPS]->(k)
     MERGE (k)-[:APPLIES_TO]->(m)`,
    { name: k.name, model: k.model, provider: k.provider, path: k.install_path, version: k.version, sha: k.sha256, src: k.source_url, now: nowIso() },
  );
}

export async function listSkills(g: GraphClient, modelId?: string): Promise<SkillRow[]> {
  const r = await g.query<{ k: { properties: SkillRow } }>(
    modelId ? "MATCH (k:Skill {model:$model}) RETURN k ORDER BY k.name" : "MATCH (k:Skill) RETURN k ORDER BY k.model, k.name",
    modelId ? { model: modelId } : {},
    { readOnly: true },
  );
  return r.rows.map((x) => x.k.properties);
}

export interface PreferenceRow {
  key: string;
  value: string;
  scope: "global" | "project" | "lane" | "model";
  scope_id: string | null;
  reason: string | null;
}
export async function upsertPreference(g: GraphClient, p: PreferenceRow): Promise<void> {
  await g.query(
    `MERGE (p:Preference {key:$key, scope:$scope, scope_id:$sid})
     ON CREATE SET p.created_at = $now
     SET p.value = $value, p.reason = $reason, p.updated_at = $now`,
    { key: p.key, scope: p.scope, sid: p.scope_id ?? "", value: p.value, reason: p.reason ?? null, now: nowIso() },
  );
}
export async function listPreferences(g: GraphClient, scope?: PreferenceRow["scope"], scopeId?: string): Promise<PreferenceRow[]> {
  const where = scope ? "WHERE p.scope = $scope AND ($sid = '' OR p.scope_id = $sid)" : "";
  const r = await g.query<{ p: { properties: PreferenceRow } }>(`MATCH (p:Preference) ${where} RETURN p ORDER BY p.key`, {
    scope: scope ?? "",
    sid: scopeId ?? "",
  }, { readOnly: true });
  return r.rows.map((x) => x.p.properties);
}

// ---------- projects & file digests ----------

export interface ProjectRow {
  slug: string;
  path: string;
  stack: string | null;
  check_cmd: string | null;
  summary: string | null;
  summary_tokens: number | null;
  updated_at: string | null;
}
export interface FileDigestRow {
  path: string;
  sha256: string;
  size: number;
  summary: string | null;
  summary_sha: string | null;
  tokens: number | null;
}

export async function upsertProject(g: GraphClient, p: { slug: string; path: string; stack?: string; checkCmd?: string }): Promise<void> {
  await g.query(
    `MERGE (p:Project {slug:$slug})
     ON CREATE SET p.created_at = $now
     SET p.path = $path, p.stack = coalesce($stack, p.stack), p.check_cmd = coalesce($check, p.check_cmd), p.updated_at = $now`,
    { slug: p.slug, path: p.path, stack: p.stack ?? null, check: p.checkCmd ?? null, now: nowIso() },
  );
}
export async function getProject(g: GraphClient, slug: string): Promise<ProjectRow | undefined> {
  const r = await g.query<{ p: { properties: ProjectRow } }>("MATCH (p:Project {slug:$slug}) RETURN p", { slug }, { readOnly: true });
  return r.rows[0]?.p?.properties;
}
export async function listProjects(g: GraphClient): Promise<ProjectRow[]> {
  const r = await g.query<{ p: { properties: ProjectRow } }>("MATCH (p:Project) RETURN p ORDER BY p.slug", {}, { readOnly: true });
  return r.rows.map((x) => x.p.properties);
}
export async function setProjectSummary(g: GraphClient, slug: string, summary: string, tokens: number): Promise<void> {
  await g.query("MATCH (p:Project {slug:$slug}) SET p.summary = $s, p.summary_tokens = $t, p.summary_at = $now", { slug, s: summary, t: tokens, now: nowIso() });
}

/** Upsert file hashes for a project; summaries survive only while the sha matches (summary_sha). */
export async function upsertFileDigests(g: GraphClient, slug: string, files: Array<{ path: string; sha256: string; size: number }>): Promise<void> {
  const BATCH = 200;
  for (let i = 0; i < files.length; i += BATCH) {
    await g.query(
      `MATCH (p:Project {slug:$slug})
       UNWIND $files AS f
       MERGE (d:FileDigest {project:$slug, path:f.path})
       ON CREATE SET d.created_at = $now, d.summary = null, d.summary_sha = null, d.tokens = 0
       SET d.sha256 = f.sha256, d.size = f.size, d.seen_at = $now
       MERGE (p)-[:HAS_FILE]->(d)`,
      { slug, files: files.slice(i, i + BATCH), now: nowIso() },
    );
  }
}
export async function removeMissingFileDigests(g: GraphClient, slug: string, keepPaths: string[]): Promise<number> {
  const r = await g.query<{ n: number }>(
    "MATCH (d:FileDigest {project:$slug}) WHERE NOT d.path IN $keep WITH d, count(d) AS n DETACH DELETE d RETURN sum(n) AS n",
    { slug, keep: keepPaths },
  );
  return r.rows[0]?.n ?? 0;
}
export async function listFileDigests(g: GraphClient, slug: string, opts: { staleOnly?: boolean } = {}): Promise<FileDigestRow[]> {
  const where = opts.staleOnly ? "WHERE d.summary IS NULL OR d.summary_sha <> d.sha256" : "";
  const r = await g.query<{ d: { properties: FileDigestRow } }>(`MATCH (d:FileDigest {project:$slug}) ${where} RETURN d ORDER BY d.path`, { slug }, { readOnly: true });
  return r.rows.map((x) => x.d.properties);
}
export async function setFileSummaries(g: GraphClient, slug: string, items: Array<{ path: string; summary: string; tokens: number; sha256: string }>): Promise<void> {
  await g.query(
    "UNWIND $items AS it MATCH (d:FileDigest {project:$slug, path:it.path}) SET d.summary = it.summary, d.tokens = it.tokens, d.summary_sha = it.sha256, d.summarized_at = $now",
    { slug, items, now: nowIso() },
  );
}
