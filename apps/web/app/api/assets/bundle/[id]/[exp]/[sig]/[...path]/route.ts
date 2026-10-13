import { htmlBundleIndex, mimeForEntry, readZipEntry, repo, zipEntryNames } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { problem } from "@/lib/api";
import { getStore, verifyBundle } from "@/lib/assets";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; exp: string; sig: string; path: string[] }> };

declare global {
  // eslint-disable-next-line no-var
  var __relayBundles: Map<string, { at: number; bytes: Buffer; root: string }> | undefined;
}
/** The zip stays in memory for a few minutes so index.html, its css and js do not each re-read the store. */
const cache = (globalThis.__relayBundles ??= new Map());
const CACHE_MS = 5 * 60_000;

/**
 * Serves one entry of an HTML bundle (a zip asset of kind html) for the sandboxed viewer iframe:
 * GET /api/assets/bundle/<id>/<exp>/<sig>/<entry path>. The signature covers the asset id and expiry so one URL
 * grants the whole bundle and relative links inside index.html keep working. Responses carry a CSP sandbox and the
 * iframe itself has sandbox="allow-scripts", so bundle scripts run in an opaque origin.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, exp, sig, path } = await ctx.params;
  const instance = req.nextUrl.pathname;
  if (dataMode() !== "db") return problem(404, "Not Found", "Bundle entries are served in db mode only.", instance);
  if (!verifyBundle(id, Number(exp), sig)) return problem(403, "Forbidden", "Bundle URL rejected: bad signature or expired.", instance);
  const entry = path.map(decodeURIComponent).join("/");
  if (!entry || entry.split("/").some((s) => s === "" || s === "." || s === "..")) return problem(400, "Bad Request", "Bad entry path.", instance);

  let hit = cache.get(id);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    const row = await repo.getAsset(await getDb(), id);
    if (!row || row.kind !== "html" || row.mime !== "application/zip") return problem(404, "Not Found", "No such HTML bundle.", instance);
    let bytes: Buffer;
    try {
      bytes = await getStore().read(row.storage_key);
    } catch {
      return problem(404, "Not Found", "Bundle bytes are missing from the store.", instance);
    }
    const index = htmlBundleIndex(zipEntryNames(bytes));
    if (!index) return problem(404, "Not Found", "The zip has no index.html.", instance);
    hit = { at: Date.now(), bytes, root: index.slice(0, -"index.html".length) };
    cache.set(id, hit);
    if (cache.size > 32) cache.delete(cache.keys().next().value as string);
  }
  const data = readZipEntry(hit.bytes, hit.root + entry);
  if (!data) return problem(404, "Not Found", `No entry '${entry}' in the bundle.`, instance);
  // The document is sandboxed into an opaque origin, where 'self' matches nothing; name the app origin so the
  // bundle's own css, js and images (served by this route) load, and nothing else does.
  const origin = req.nextUrl.origin;
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "content-type": mimeForEntry(entry),
      "content-length": String(data.length),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": `sandbox allow-scripts; default-src ${origin} data: blob: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data:; frame-src 'none'; form-action 'none'`,
    },
  });
}
