import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { sniffMime, verifyLocalSignedUrl } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { localStore } from "@/lib/assets";
import { problem } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Streams a local-store object for a signed URL: GET /api/assets/stream?key=&exp=&sig=. The token is the one
 * LocalStore minted (HMAC over "<key>\n<exp>"); verification is constant-time, refuses expiry, and refuses any key
 * that resolves outside the asset root. In Blob mode this route does not apply: view URLs are presigned Blob URLs.
 */
export async function GET(req: NextRequest) {
  const store = localStore();
  if (!store) return problem(404, "Not Found", "This deployment serves assets from Vercel Blob; use the signed URL from the API.", req.nextUrl.pathname);
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
  const v = verifyLocalSignedUrl(fileUrl.toString(), store);
  if (!v.ok) return problem(v.reason === "expired" ? 410 : 403, v.reason === "expired" ? "Gone" : "Forbidden", `Signed URL rejected: ${v.reason}.`, req.nextUrl.pathname);
  let size: number;
  try {
    const st = statSync(v.path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return problem(404, "Not Found", "No such object.", req.nextUrl.pathname);
  }
  // Content type from the first bytes, then the key's extension; never trust a stored name alone.
  const head = Buffer.alloc(Math.min(64, size));
  if (size) {
    const { openSync, readSync, closeSync } = await import("node:fs");
    const fd = openSync(v.path, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  }
  const mime = sniffMime(head, key);
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": "private, max-age=300",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename="${encodeURIComponent(key.split("/").pop() ?? "asset")}"`,
    // Bare HTML files are shown in a sandboxed iframe; never let them run as part of the app's origin.
    // A bare HTML file is sandboxed into an opaque origin, where 'self' matches nothing; name the app origin instead.
    ...(mime === "text/html" ? { "content-security-policy": `sandbox allow-scripts; default-src ${req.nextUrl.origin} data: blob: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data:; frame-src 'none'; form-action 'none'` } : {}),
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start <= end && start < size) {
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
        headers["content-length"] = String(end - start + 1);
        return new NextResponse(Readable.toWeb(createReadStream(v.path, { start, end })) as ReadableStream, { status: 206, headers });
      }
      return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
  }
  headers["content-length"] = String(size);
  return new NextResponse(Readable.toWeb(createReadStream(v.path)) as ReadableStream, { status: 200, headers });
}
