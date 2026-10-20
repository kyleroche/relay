/**
 * The asset library's rows: versions, review, publish, retention (docs/ASSETS.md). Every state change appends an
 * event (`asset.uploaded`, `asset.reviewed`, `asset.published`) and a rejection note becomes a `review` decision so
 * the next attempt's brief carries it. Bytes live in an AssetStore (../assets/store.ts); this module only knows keys.
 */
import { type Db, iso, num } from "./client.ts";
import { writeEvent } from "./events.ts";
import { addDecision } from "./memory.ts";
import { getProject } from "./projects.ts";
import { ulid } from "../util.ts";

export type AssetKind = "image" | "video" | "audio" | "pdf" | "html" | "file";
export type AssetStatus = "pending" | "approved" | "rejected" | "superseded" | "published";

export interface AssetRow {
  id: string;
  project: string | null;
  issue: number | null;
  pr: number | null;
  title: string;
  description: string | null;
  kind: AssetKind;
  mime: string;
  size: number;
  sha256: string;
  storage_key: string;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  version: number;
  parent_id: string | null;
  status: AssetStatus;
  created_by: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  public_url: string | null;
  expires_at: string | null;
  tags: string[];
}

export interface CreateAssetInput {
  project?: string | null;
  issue?: number | null;
  pr?: number | null;
  title: string;
  description?: string | null;
  kind: AssetKind;
  mime: string;
  size: number;
  sha256: string;
  storageKey: string;
  thumbKey?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  createdBy: string;
  tags?: string[];
  /** Caller-supplied id (the ingest step names the storage key after it); default: a fresh ulid. */
  id?: string;
}

export interface ListAssetsOpts {
  project?: string;
  status?: AssetStatus;
  kind?: AssetKind;
  issue?: number;
  pr?: number;
  limit?: number;
}

export const DEFAULT_RETENTION_DAYS = 30;
/** Days a rejected or superseded version is kept before `expireAssets` reclaims it (env RELAY_ASSET_RETENTION_DAYS). */
export function retentionDays(): number {
  const n = Number(process.env.RELAY_ASSET_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

const cols =
  "id, project, issue, pr, title, description, kind, mime, size, sha256, storage_key, thumb_key, width, height, duration_ms, version, parent_id, status, created_by, created_at, reviewed_by, reviewed_at, review_note, public_url, expires_at, tags";

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const toAsset = (r: Record<string, unknown>): AssetRow => ({
  id: r.id as string,
  project: str(r.project),
  issue: int(r.issue),
  pr: int(r.pr),
  title: r.title as string,
  description: str(r.description),
  kind: r.kind as AssetKind,
  mime: r.mime as string,
  size: num(r.size),
  sha256: r.sha256 as string,
  storage_key: r.storage_key as string,
  thumb_key: str(r.thumb_key),
  width: int(r.width),
  height: int(r.height),
  duration_ms: int(r.duration_ms),
  version: num(r.version),
  parent_id: str(r.parent_id),
  status: r.status as AssetStatus,
  created_by: r.created_by as string,
  created_at: iso(r.created_at) ?? "",
  reviewed_by: str(r.reviewed_by),
  reviewed_at: iso(r.reviewed_at),
  review_note: str(r.review_note),
  public_url: str(r.public_url),
  expires_at: iso(r.expires_at),
  tags: Array.isArray(r.tags) ? (r.tags as string[]) : typeof r.tags === "string" ? parsePgArray(r.tags) : [],
});

/** pg returns text[] as a JS array; a raw `{a,b}` literal only shows up through odd casts, but be safe. */
function parsePgArray(s: string): string[] {
  const inner = s.replace(/^\{|\}$/g, "");
  if (!inner) return [];
  return inner.split(",").map((x) => x.replace(/^"|"$/g, ""));
}

export class AssetNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`asset ${id} not found`);
    this.name = "AssetNotFoundError";
  }
}

/**
 * The repository an asset's events name: the project's repo when the asset sits on an issue or PR, so the row reaches
 * the task's fold (deriveTaskStatus keys on repo + issue; the asset path in docs/ARCHITECTURE.md "A task's life").
 * Null for a loose asset, or a project without a repository.
 */
async function repoOf(db: Db, row: Pick<AssetRow, "project" | "issue" | "pr">): Promise<string | null> {
  if (!row.project || (row.issue == null && row.pr == null)) return null;
  return (await getProject(db, row.project))?.repo ?? null;
}

async function insertAsset(db: Db, a: CreateAssetInput, version: number, parentId: string | null): Promise<AssetRow> {
  const id = a.id ?? ulid();
  const r = await db.query(
    `INSERT INTO assets (id, project, issue, pr, title, description, kind, mime, size, sha256, storage_key, thumb_key, width, height, duration_ms, version, parent_id, created_by, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::text[])
     RETURNING ${cols}`,
    [
      id, a.project ?? null, a.issue ?? null, a.pr ?? null, a.title, a.description ?? null, a.kind, a.mime, a.size, a.sha256, a.storageKey,
      a.thumbKey ?? null, a.width ?? null, a.height ?? null, a.durationMs ?? null, version, parentId, a.createdBy, a.tags ?? [],
    ],
  );
  const row = toAsset(r[0]!);
  await writeEvent(db, {
    kind: "asset.uploaded",
    actor: a.createdBy,
    project: row.project,
    repo: await repoOf(db, row),
    issue: row.issue,
    pr: row.pr,
    summary: version > 1 ? `${row.title} (v${version})` : row.title,
    payload: { asset_id: row.id, kind: row.kind, mime: row.mime, size: row.size, version, parent_id: parentId, sha256: row.sha256 },
  });
  return row;
}

/** Insert version 1 of a new asset and write `asset.uploaded`. The bytes must already be in the store. */
export async function createAsset(db: Db, a: CreateAssetInput): Promise<AssetRow> {
  return db.transaction((tx) => insertAsset(tx, a, 1, null));
}

export async function getAsset(db: Db, id: string): Promise<AssetRow | undefined> {
  const r = await db.query(`SELECT ${cols} FROM assets WHERE id = $1`, [id]);
  return r[0] ? toAsset(r[0]) : undefined;
}

/** Newest first; pending before everything else so the review queue floats to the top. */
export async function listAssets(db: Db, opts: ListAssetsOpts = {}): Promise<AssetRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (opts.project) add("project = ?", opts.project);
  if (opts.status) add("status = ?", opts.status);
  if (opts.kind) add("kind = ?", opts.kind);
  if (opts.issue !== undefined) add("issue = ?", opts.issue);
  if (opts.pr !== undefined) add("pr = ?", opts.pr);
  params.push(opts.limit ?? 100);
  const r = await db.query(
    `SELECT ${cols} FROM assets ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY (status = 'pending') DESC, created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return r.map(toAsset);
}

/** All versions in one chain (walks to the root, then every descendant), oldest first. */
export async function listVersions(db: Db, id: string): Promise<AssetRow[]> {
  const r = await db.query(
    `WITH RECURSIVE up AS (
       SELECT a.* FROM assets a WHERE a.id = $1
       UNION ALL SELECT p.* FROM assets p JOIN up ON up.parent_id = p.id
     ), root AS (SELECT id FROM up WHERE parent_id IS NULL LIMIT 1),
     down AS (
       SELECT a.* FROM assets a WHERE a.id = (SELECT id FROM root)
       UNION ALL SELECT c.* FROM assets c JOIN down ON c.parent_id = down.id
     )
     SELECT ${cols} FROM down ORDER BY version, created_at`,
    [id],
  );
  return r.map(toAsset);
}

/**
 * Store a replacement for `parentId`: the new row gets version+1 and inherits project/issue/pr/title unless given,
 * the parent becomes `superseded` with an expiry. Writes one `asset.uploaded` event.
 */
export async function newVersion(db: Db, parentId: string, a: Omit<CreateAssetInput, "title"> & { title?: string }): Promise<AssetRow> {
  return db.transaction(async (tx) => {
    const parent = await getAsset(tx, parentId);
    if (!parent) throw new AssetNotFoundError(parentId);
    const row = await insertAsset(
      tx,
      {
        ...a,
        title: a.title ?? parent.title,
        project: a.project === undefined ? parent.project : a.project,
        issue: a.issue === undefined ? parent.issue : a.issue,
        pr: a.pr === undefined ? parent.pr : a.pr,
        description: a.description === undefined ? parent.description : a.description,
        tags: a.tags ?? parent.tags,
      },
      parent.version + 1,
      parent.id,
    );
    await tx.query(
      `UPDATE assets SET status = 'superseded', expires_at = now() + ($2 || ' days')::interval WHERE id = $1 AND status IN ('pending', 'approved', 'rejected')`,
      [parent.id, String(retentionDays())],
    );
    return row;
  });
}

export interface ReviewInput {
  decision: "approved" | "rejected";
  /** Actor, e.g. human:kyle. */
  by: string;
  note?: string | null;
}

/**
 * Approve or reject. Writes `asset.reviewed` (note in the summary); a rejection also sets an expiry and records the
 * note as a project decision (source `review`, source_ref = asset id) so the next attempt's brief includes it. On an
 * asset that is a task's deliverable (it sits on the issue) the same row is the task's review: approved is `done`,
 * rejected is `queued` with the note under "Review feedback" in the next run's brief (tasks/review.ts `reviewNotes`).
 */
export async function reviewAsset(db: Db, id: string, r: ReviewInput): Promise<AssetRow> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE assets SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4,
         expires_at = CASE WHEN $2 = 'rejected' THEN now() + ($5 || ' days')::interval ELSE NULL END
       WHERE id = $1 RETURNING ${cols}`,
      [id, r.decision, r.by, r.note ?? null, String(retentionDays())],
    );
    if (!rows[0]) throw new AssetNotFoundError(id);
    const row = toAsset(rows[0]);
    const verb = r.decision === "approved" ? "approved" : "rejected";
    await writeEvent(tx, {
      kind: "asset.reviewed",
      actor: r.by,
      project: row.project,
      repo: await repoOf(tx, row),
      issue: row.issue,
      pr: row.pr,
      summary: `${verb}: ${row.title}${r.note ? ` — ${r.note}` : ""}`,
      payload: { asset_id: row.id, decision: r.decision, note: r.note ?? null, version: row.version },
    });
    if (r.decision === "rejected" && r.note) {
      await addDecision(tx, { project: row.project, text: `Rejected "${row.title}" (v${row.version}): ${r.note}`, source: "review", sourceRef: row.id });
    }
    return row;
  });
}

/** Record that a public URL now exists for this asset. Writes `asset.published`. Status becomes `published`. */
export async function publishAsset(db: Db, id: string, publicUrl: string, opts: { by?: string } = {}): Promise<AssetRow> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(`UPDATE assets SET status = 'published', public_url = $2, expires_at = NULL WHERE id = $1 RETURNING ${cols}`, [id, publicUrl]);
    if (!rows[0]) throw new AssetNotFoundError(id);
    const row = toAsset(rows[0]);
    await writeEvent(tx, {
      kind: "asset.published",
      actor: opts.by ?? row.created_by,
      project: row.project,
      repo: await repoOf(tx, row),
      issue: row.issue,
      pr: row.pr,
      url: publicUrl,
      summary: `published: ${row.title}`,
      payload: { asset_id: row.id, public_url: publicUrl, version: row.version },
    });
    return row;
  });
}

export interface ExpiredAsset {
  id: string;
  /** Storage keys the caller must delete from the AssetStore (storage_key, and thumb_key when set). */
  keys: string[];
}

/** Rejected or superseded rows whose retention has passed, without touching them (dry run). */
export async function listExpiredAssets(db: Db, now: Date = new Date()): Promise<AssetRow[]> {
  const r = await db.query(
    `SELECT ${cols} FROM assets WHERE status IN ('rejected', 'superseded') AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz ORDER BY expires_at`,
    [now.toISOString()],
  );
  return r.map(toAsset);
}

/**
 * Delete the rows `listExpiredAssets` would return and hand back the storage keys to delete. Rows go first so a
 * failed blob delete leaves at most an orphan object, never a row pointing at missing bytes. Thumbnails shared with
 * a surviving row are not returned.
 */
export async function expireAssets(db: Db, now: Date = new Date()): Promise<ExpiredAsset[]> {
  return db.transaction(async (tx) => {
    const gone = await tx.query<{ id: string; storage_key: string; thumb_key: string | null }>(
      `DELETE FROM assets WHERE status IN ('rejected', 'superseded') AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING id, storage_key, thumb_key`,
      [now.toISOString()],
    );
    if (!gone.length) return [];
    const keys = gone.flatMap((g) => [g.storage_key, ...(g.thumb_key ? [g.thumb_key] : [])]);
    const still = await tx.query<{ k: string }>(
      `SELECT storage_key AS k FROM assets WHERE storage_key = ANY($1::text[]) UNION SELECT thumb_key FROM assets WHERE thumb_key = ANY($1::text[])`,
      [keys],
    );
    const inUse = new Set(still.map((s) => s.k));
    return gone.map((g) => ({ id: g.id, keys: [g.storage_key, ...(g.thumb_key ? [g.thumb_key] : [])].filter((k) => !inUse.has(k)) }));
  });
}
