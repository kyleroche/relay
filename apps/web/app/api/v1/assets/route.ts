import { ingestFile, repo, sniffMime, ulid, uploadKeyFor, safeFilename, type AssetKind, type AssetStatus } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { absoluteAsset, afterUpload } from "@/lib/asset-hooks";
import { getStore, publicUploadUrl, toAsset, UPLOAD_TTL } from "@/lib/assets";
import { dataMode, getAssets } from "@/lib/data";
import { getDb } from "@/lib/db";
import { ASSET_KINDS, ASSET_STATUSES } from "@/lib/types";

export const dynamic = "force-dynamic";

const intParam = (v: string | null): number | undefined => (v == null || v === "" ? undefined : Number(v));

/** operationId: listAssets */
export const GET = api(
  async (req) => {
    const sp = req.nextUrl.searchParams;
    const instance = req.nextUrl.pathname;
    const status = sp.get("status");
    const kind = sp.get("kind");
    if (status && !ASSET_STATUSES.includes(status as AssetStatus)) return problem(400, "Bad Request", `status must be one of ${ASSET_STATUSES.join(", ")}.`, instance, { parameter: "status" });
    if (kind && !ASSET_KINDS.includes(kind as AssetKind)) return problem(400, "Bad Request", `kind must be one of ${ASSET_KINDS.join(", ")}.`, instance, { parameter: "kind" });
    const limit = intParam(sp.get("limit")) ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return problem(400, "Bad Request", "limit must be an integer between 1 and 200.", instance, { parameter: "limit" });
    const issue = intParam(sp.get("issue"));
    const pr = intParam(sp.get("pr"));
    const assets = await getAssets({
      ...(sp.get("project") ? { project: sp.get("project") as string } : {}),
      ...(status ? { status: status as AssetStatus } : {}),
      ...(kind ? { kind: kind as AssetKind } : {}),
      ...(issue !== undefined && Number.isInteger(issue) ? { issue } : {}),
      ...(pr !== undefined && Number.isInteger(pr) ? { pr } : {}),
      limit,
    });
    return json({ assets: assets.map(absoluteAsset), count: assets.length });
  },
  { scope: "assets:read" },
);

interface Meta {
  project: string;
  issue?: number;
  pr?: number;
  title?: string;
  description?: string;
  replaces?: string;
  tags?: string[];
  by?: string;
}

function readMeta(get: (k: string) => unknown): Meta | string {
  const project = get("project");
  if (typeof project !== "string" || !project) return "project is required";
  const num = (k: string): number | undefined | string => {
    const v = get(k);
    if (v === undefined || v === null || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : `${k} must be a non-negative integer`;
  };
  const issue = num("issue");
  if (typeof issue === "string") return issue;
  const pr = num("pr");
  if (typeof pr === "string") return pr;
  const str = (k: string) => (typeof get(k) === "string" && (get(k) as string) !== "" ? (get(k) as string) : undefined);
  const rawTags = get("tags");
  const tags = Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === "string") : typeof rawTags === "string" && rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  return {
    project,
    ...(issue !== undefined ? { issue } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(str("title") ? { title: str("title") as string } : {}),
    ...(str("description") ? { description: str("description") as string } : {}),
    ...(str("replaces") ? { replaces: str("replaces") as string } : {}),
    ...(tags ? { tags } : {}),
    ...(str("by") ? { by: str("by") as string } : {}),
  };
}

/**
 * operationId: createAsset. Two bodies:
 *   multipart/form-data with a `file` part (plus project, issue, pr, title, description, replaces, tags, by): the
 *     bytes are ingested here and the asset is created in one call (201, the asset).
 *   application/json { presign: true, project, filename, content_type?, ... }: returns a one-time upload URL and the
 *     asset id (201); PUT the bytes there, then POST /api/v1/assets/{id}/finalize with the same metadata.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    if (dataMode() !== "db") return problem(501, "Not Implemented", "Uploads need a database and an asset store (RELAY_DATA=db). Mock mode serves demo assets only.", instance);
    const grant = await callerGrant(req);
    const actorDefault = grant?.actor ?? "token:unknown";
    const db = await getDb();
    const store = getStore();
    const ctype = req.headers.get("content-type") ?? "";

    if (ctype.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return problem(400, "Bad Request", "multipart body needs a `file` part.", instance, { parameter: "file" });
      const meta = readMeta((k) => form.get(k) ?? undefined);
      if (typeof meta === "string") return problem(400, "Bad Request", meta, instance);
      if (!(await repo.getProject(db, meta.project))) return problem(404, "Not Found", `No project with slug '${meta.project}'.`, instance);
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!buffer.length) return problem(400, "Bad Request", "file is empty.", instance, { parameter: "file" });
      const row = await ingestFile(db, store, {
        buffer,
        filename: file.name || "asset",
        project: meta.project,
        issue: meta.issue,
        pr: meta.pr,
        title: meta.title,
        description: meta.description,
        replaces: meta.replaces ?? null,
        createdBy: meta.by ?? actorDefault,
        tags: meta.tags,
      });
      const asset = absoluteAsset(await toAsset(row));
      await afterUpload(asset);
      return json(asset, { status: 201, headers: { location: `/api/v1/assets/${row.id}` } });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return problem(400, "Bad Request", "Body must be multipart/form-data with a file, or JSON with presign: true.", instance);
    }
    if (body.presign !== true) return problem(400, "Bad Request", "JSON bodies must set presign: true (or send multipart/form-data with a file).", instance, { parameter: "presign" });
    const meta = readMeta((k) => body[k]);
    if (typeof meta === "string") return problem(400, "Bad Request", meta, instance);
    const filename = typeof body.filename === "string" && body.filename ? safeFilename(body.filename) : undefined;
    if (!filename) return problem(400, "Bad Request", "filename is required for a presigned upload.", instance, { parameter: "filename" });
    if (!(await repo.getProject(db, meta.project))) return problem(404, "Not Found", `No project with slug '${meta.project}'.`, instance);
    const id = ulid();
    const key = uploadKeyFor(meta.project, id, filename);
    const contentType = typeof body.content_type === "string" && body.content_type ? body.content_type : sniffMime(Buffer.alloc(0), filename);
    const raw = await store.getUploadUrl(key, UPLOAD_TTL, { contentType });
    return json(
      {
        id,
        key,
        upload_url: publicUploadUrl(raw, key, true),
        method: "PUT",
        headers: { "content-type": contentType },
        expires_at: new Date(Date.now() + UPLOAD_TTL * 1000).toISOString(),
        finalize_url: `${new URL(req.url).origin}/api/v1/assets/${id}/finalize`,
        finalize_body: {
          key,
          project: meta.project,
          ...(meta.issue !== undefined ? { issue: meta.issue } : {}),
          ...(meta.pr !== undefined ? { pr: meta.pr } : {}),
          ...(meta.title ? { title: meta.title } : {}),
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.replaces ? { replaces: meta.replaces } : {}),
          ...(meta.tags ? { tags: meta.tags } : {}),
          ...(meta.by ? { by: meta.by } : {}),
        },
      },
      { status: 201 },
    );
  },
  { scope: "assets:write" },
);
