import { finalizeFromKey, IngestError, parseUploadKey, repo } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { absoluteAsset, afterUpload } from "@/lib/asset-hooks";
import { getStore, toAsset } from "@/lib/assets";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * operationId: finalizeAsset. After a presigned PUT: probe the uploaded object and create the row. Body is the
 * `finalize_body` the presign response returned (key, project, issue, pr, title, description, replaces, tags, by).
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    if (dataMode() !== "db") return problem(501, "Not Implemented", "Uploads need a database and an asset store (RELAY_DATA=db).", instance);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return problem(400, "Bad Request", "Body must be JSON.", instance);
    }
    const key = typeof body.key === "string" ? body.key : "";
    const parsed = parseUploadKey(key);
    if (!parsed || parsed.id !== id) return problem(400, "Bad Request", `key must be the upload key issued for asset '${id}'.`, instance, { parameter: "key" });
    const project = typeof body.project === "string" ? body.project : parsed.project;
    if (!project) return problem(400, "Bad Request", "project is required.", instance, { parameter: "project" });
    const db = await getDb();
    if (await repo.getAsset(db, id)) return problem(409, "Conflict", `Asset '${id}' was already finalized.`, instance);
    const int = (k: string) => (typeof body[k] === "number" && Number.isInteger(body[k]) ? (body[k] as number) : undefined);
    const str = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : undefined);
    const grant = await callerGrant(req);
    try {
      const row = await finalizeFromKey(db, getStore(), {
        key,
        project,
        issue: int("issue"),
        pr: int("pr"),
        title: str("title"),
        description: str("description"),
        replaces: str("replaces") ?? null,
        tags: Array.isArray(body.tags) ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
        createdBy: str("by") ?? grant?.actor ?? "token:unknown",
      });
      const asset = absoluteAsset(await toAsset(row));
      await afterUpload(asset);
      return json(asset, { status: 201 });
    } catch (e) {
      if (e instanceof IngestError) return problem(e.message.includes("nothing was uploaded") ? 404 : 400, e.message.includes("nothing was uploaded") ? "Not Found" : "Bad Request", e.message, instance);
      if (e instanceof repo.AssetNotFoundError) return problem(404, "Not Found", `replaces: ${e.message}.`, instance, { parameter: "replaces" });
      throw e;
    }
  },
  { scope: "assets:write" },
);
