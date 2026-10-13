/** Projects and per-file digests. Writers upsert on the natural key so re-runs are idempotent. */
import { type Db, iso, num } from "./client.ts";

export interface ProjectRow {
  slug: string;
  repo: string | null;
  path: string | null;
  stack: string | null;
  check_cmd: string | null;
  summary: string | null;
  summary_tokens: number | null;
  created_at: string | null;
  updated_at: string | null;
}
export interface FileDigestRow {
  path: string;
  sha256: string;
  size: number;
  summary: string | null;
  summary_sha: string | null;
  tokens: number | null;
  seen_at: string | null;
  summarized_at: string | null;
}

const projectCols = "slug, repo, path, stack, check_cmd, summary, summary_tokens, created_at, updated_at";
const toProject = (r: Record<string, unknown>): ProjectRow => ({
  slug: r.slug as string,
  repo: (r.repo as string | null) ?? null,
  path: (r.path as string | null) ?? null,
  stack: (r.stack as string | null) ?? null,
  check_cmd: (r.check_cmd as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  summary_tokens: r.summary_tokens == null ? null : num(r.summary_tokens),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

export async function upsertProject(db: Db, p: { slug: string; path?: string; repo?: string; stack?: string; checkCmd?: string }): Promise<void> {
  await db.query(
    `INSERT INTO projects (slug, repo, path, stack, check_cmd) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO UPDATE SET
       repo = coalesce(EXCLUDED.repo, projects.repo),
       path = coalesce(EXCLUDED.path, projects.path),
       stack = coalesce(EXCLUDED.stack, projects.stack),
       check_cmd = coalesce(EXCLUDED.check_cmd, projects.check_cmd),
       updated_at = now()`,
    [p.slug, p.repo ?? null, p.path ?? null, p.stack ?? null, p.checkCmd ?? null],
  );
}

export async function getProject(db: Db, slug: string): Promise<ProjectRow | undefined> {
  const r = await db.query(`SELECT ${projectCols} FROM projects WHERE slug = $1`, [slug]);
  return r[0] ? toProject(r[0]) : undefined;
}

export async function listProjects(db: Db): Promise<ProjectRow[]> {
  return (await db.query(`SELECT ${projectCols} FROM projects ORDER BY slug`)).map(toProject);
}

export async function setProjectSummary(db: Db, slug: string, summary: string, tokens: number): Promise<void> {
  await db.query("UPDATE projects SET summary = $2, summary_tokens = $3, updated_at = now() WHERE slug = $1", [slug, summary, tokens]);
}

/** Upsert file hashes for a project; an existing summary survives, and is stale while summary_sha <> sha256. */
export async function upsertFileDigests(db: Db, slug: string, files: Array<{ path: string; sha256: string; size: number }>): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < files.length; i += BATCH) {
    const slice = files.slice(i, i + BATCH);
    await db.query(
      `INSERT INTO file_digests (project, path, sha256, size, seen_at)
       SELECT $1, f.path, f.sha256, f.size, now()
       FROM unnest($2::text[], $3::text[], $4::int[]) AS f(path, sha256, size)
       ON CONFLICT (project, path) DO UPDATE SET sha256 = EXCLUDED.sha256, size = EXCLUDED.size, seen_at = now()`,
      [slug, slice.map((f) => f.path), slice.map((f) => f.sha256), slice.map((f) => f.size)],
    );
  }
}

export async function removeMissingFileDigests(db: Db, slug: string, keepPaths: string[]): Promise<number> {
  const r = await db.query<{ n: unknown }>(
    `WITH gone AS (DELETE FROM file_digests WHERE project = $1 AND NOT (path = ANY($2::text[])) RETURNING 1)
     SELECT count(*) AS n FROM gone`,
    [slug, keepPaths],
  );
  return num(r[0]?.n);
}

const digestCols = "path, sha256, size, summary, summary_sha, tokens, seen_at, summarized_at";
const toDigest = (r: Record<string, unknown>): FileDigestRow => ({
  path: r.path as string,
  sha256: r.sha256 as string,
  size: num(r.size),
  summary: (r.summary as string | null) ?? null,
  summary_sha: (r.summary_sha as string | null) ?? null,
  tokens: r.tokens == null ? null : num(r.tokens),
  seen_at: iso(r.seen_at),
  summarized_at: iso(r.summarized_at),
});

export async function listFileDigests(db: Db, slug: string, opts: { staleOnly?: boolean } = {}): Promise<FileDigestRow[]> {
  const where = opts.staleOnly ? "AND (summary IS NULL OR summary_sha IS DISTINCT FROM sha256)" : "";
  return (await db.query(`SELECT ${digestCols} FROM file_digests WHERE project = $1 ${where} ORDER BY path`, [slug])).map(toDigest);
}

export async function setFileSummaries(db: Db, slug: string, items: Array<{ path: string; summary: string; tokens: number; sha256: string }>): Promise<void> {
  if (!items.length) return;
  await db.query(
    `UPDATE file_digests d SET summary = it.summary, tokens = it.tokens, summary_sha = it.sha256, summarized_at = now()
     FROM unnest($2::text[], $3::text[], $4::int[], $5::text[]) AS it(path, summary, tokens, sha256)
     WHERE d.project = $1 AND d.path = it.path`,
    [slug, items.map((i) => i.path), items.map((i) => i.summary), items.map((i) => i.tokens), items.map((i) => i.sha256)],
  );
}
