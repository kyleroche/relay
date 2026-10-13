import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalStore, verifyLocalUploadUrl } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/assets";
import { problem } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Uploads through this route are capped; larger masters go to Blob, where the presigned PUT goes straight to storage. */
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * The local-store half of a presigned upload: PUT /api/assets/upload?key=&exp=&sig= with the bytes as the body. The
 * token is the one LocalStore.getUploadUrl minted (HMAC over "upload/<key>\n<exp>"), so a view token never writes.
 * Finish with POST /api/v1/assets/{id}/finalize. In Blob mode the presigned URL points at Blob and this route 404s.
 */
export async function PUT(req: NextRequest) {
  const store = getStore();
  if (!(store instanceof LocalStore)) return problem(404, "Not Found", "This deployment uploads straight to Vercel Blob; use the presigned URL from the API.", req.nextUrl.pathname);
  const sp = req.nextUrl.searchParams;
  const key = sp.get("key") ?? "";
  const exp = sp.get("exp") ?? "";
  const sig = sp.get("sig") ?? "";
  if (!key || !exp || !sig) return problem(400, "Bad Request", "key, exp and sig are required.", req.nextUrl.pathname);
  let fileUrl: URL;
  try {
    fileUrl = pathToFileURL(join(store.root, ...key.split("/")));
  } catch {
    return problem(400, "Bad Request", "Bad key.", req.nextUrl.pathname);
  }
  fileUrl.searchParams.set("exp", exp);
  fileUrl.searchParams.set("sig", sig);
  fileUrl.searchParams.set("op", "put");
  const v = verifyLocalUploadUrl(fileUrl.toString(), store);
  if (!v.ok) return problem(v.reason === "expired" ? 410 : 403, v.reason === "expired" ? "Gone" : "Forbidden", `Upload URL rejected: ${v.reason}.`, req.nextUrl.pathname);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return problem(413, "Content Too Large", `Uploads through the local store are capped at ${MAX_BYTES} bytes.`, req.nextUrl.pathname);
  const bytes = Buffer.from(await req.arrayBuffer());
  if (!bytes.length) return problem(400, "Bad Request", "Empty body.", req.nextUrl.pathname);
  if (bytes.length > MAX_BYTES) return problem(413, "Content Too Large", `Uploads through the local store are capped at ${MAX_BYTES} bytes.`, req.nextUrl.pathname);
  await store.put(v.key, bytes, { contentType: req.headers.get("content-type") ?? "application/octet-stream" });
  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
