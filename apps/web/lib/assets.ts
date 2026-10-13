/**
 * Server-side glue between @relay/core's asset library and this app's routes (db mode only; mock mode has its own
 * URLs under /api/assets/mock). The store never hands a `file://` URL to a browser: local signed URLs are rewritten
 * to /api/assets/stream (reads) and /api/assets/upload (presigned writes), both of which verify the HMAC token
 * before touching disk. Blob presigned URLs pass through untouched.
 *
 * HTML bundles are served entry by entry from /api/assets/bundle/<id>/<exp>/<sig>/<path>, signed here with an
 * app-level HMAC so the same URL shape works for both stores, and so relative links inside index.html resolve.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { LocalStore, openAssetStore, type AssetRow, type AssetStore } from "@relay/core";
import { SITE_URL } from "@/lib/site";
import type { Asset, AssetVersion } from "@/lib/types";

declare global {
  // eslint-disable-next-line no-var
  var __relayAssetStore: AssetStore | undefined;
}

/** Signed view URLs live this long (seconds). Long enough to scroll a gallery, short enough to be harmless when shared. */
export const VIEW_TTL = 3600;
/** Presigned upload URLs live this long (seconds). */
export const UPLOAD_TTL = 900;

export function getStore(): AssetStore {
  return (globalThis.__relayAssetStore ??= openAssetStore());
}

/** Absolute URLs when the caller is an API client or GitHub; relative on pages. */
function base(absolute: boolean): string {
  return absolute ? SITE_URL : "";
}

/** A store URL the browser can fetch: file:// becomes the app's streaming route; anything else passes through. */
export function publicViewUrl(signed: string, key: string, absolute = false): string {
  if (!signed.startsWith("file:")) return signed;
  const u = new URL(signed);
  const q = new URLSearchParams({ key, exp: u.searchParams.get("exp") ?? "", sig: u.searchParams.get("sig") ?? "" });
  return `${base(absolute)}/api/assets/stream?${q}`;
}

/** A store upload URL the client can PUT to: file:// becomes the app's upload route; Blob presigned URLs pass through. */
export function publicUploadUrl(signed: string, key: string, absolute = false): string {
  if (!signed.startsWith("file:")) return signed;
  const u = new URL(signed);
  const q = new URLSearchParams({ key, exp: u.searchParams.get("exp") ?? "", sig: u.searchParams.get("sig") ?? "" });
  return `${base(absolute)}/api/assets/upload?${q}`;
}

export async function viewUrl(key: string | null, absolute = false): Promise<string | null> {
  if (!key) return null;
  try {
    const store = getStore();
    return publicViewUrl(await store.getSignedUrl(key, VIEW_TTL), key, absolute);
  } catch {
    return null;
  }
}

// ---------- bundle signing (app level, store independent) ----------

/**
 * The local store, or undefined in Blob mode. Checked by `kind`, never `instanceof`: the store instance is shared on
 * globalThis across Next's server bundles (pages, route handlers), each of which carries its own copy of the class.
 */
export function localStore(): LocalStore | undefined {
  const store = getStore();
  return store.kind === "local" ? (store as LocalStore) : undefined;
}

function bundleSecret(): Buffer {
  const env = process.env.RELAY_ASSET_SIGNING_KEY;
  if (env) return Buffer.from(env, "utf8");
  const local = localStore();
  if (local) return local.signingSecret();
  // Blob mode without RELAY_ASSET_SIGNING_KEY: the store token is a secret the app already holds.
  return Buffer.from(process.env.BLOB_READ_WRITE_TOKEN ?? "relay", "utf8");
}

export function signBundle(id: string, exp: number): string {
  return createHmac("sha256", bundleSecret()).update(`bundle/${id}\n${exp}`).digest("base64url");
}

export function verifyBundle(id: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const want = Buffer.from(signBundle(id, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** URL of the bundle's index entry (zip) or of the bare html file (stream route), for the sandboxed iframe. */
export async function bundleUrl(row: AssetRow, absolute = false): Promise<string | null> {
  if (row.kind !== "html") return null;
  if (row.mime !== "application/zip") return viewUrl(row.storage_key, absolute);
  const exp = Math.floor(Date.now() / 1000) + VIEW_TTL;
  return `${base(absolute)}/api/assets/bundle/${row.id}/${exp}/${signBundle(row.id, exp)}/index.html`;
}

// ---------- shapes ----------

export async function toAsset(row: AssetRow, absolute = false): Promise<Asset> {
  const { storage_key, thumb_key, ...rest } = row;
  const [url, thumb_url, bundle_url] = await Promise.all([viewUrl(storage_key, absolute), viewUrl(thumb_key, absolute), bundleUrl(row, absolute)]);
  return { ...rest, url, thumb_url, bundle_url };
}

export async function toVersion(row: AssetRow, absolute = false): Promise<AssetVersion> {
  return { id: row.id, version: row.version, status: row.status, created_at: row.created_at, created_by: row.created_by, thumb_url: await viewUrl(row.thumb_key, absolute) };
}

export function taskUrl(repo: string | null | undefined, row: Pick<AssetRow, "issue" | "pr">): string | null {
  if (!repo) return null;
  if (row.pr) return `https://github.com/${repo}/pull/${row.pr}`;
  if (row.issue) return `https://github.com/${repo}/issues/${row.issue}`;
  return null;
}
