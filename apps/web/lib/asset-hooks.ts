/**
 * What happens after an asset changes through the API or the viewer: the GitHub comment hooks (db mode only; the
 * mock projects have no real repositories) and absolute URLs for API clients. Everything here is best effort.
 */
import { repo } from "@relay/core";
import { getDb } from "@/lib/db";
import { dataMode } from "@/lib/data";
import { commentReviewed, commentUploaded } from "@/lib/github";
import { SITE_URL } from "@/lib/site";
import type { Asset, AssetDetail } from "@/lib/types";

async function repoOf(project: string | null): Promise<string | null> {
  if (!project || dataMode() !== "db") return null;
  try {
    return (await repo.getProject(await getDb(), project))?.repo ?? null;
  } catch {
    return null;
  }
}

export async function afterUpload(asset: Asset): Promise<void> {
  await commentUploaded(await repoOf(asset.project), asset);
}

export async function afterReview(asset: Asset): Promise<void> {
  await commentReviewed(await repoOf(asset.project), asset);
}

const abs = (u: string | null) => (u && u.startsWith("/") ? `${SITE_URL}${u}` : u);

/** Page URLs are relative; API clients get absolute ones. */
export function absoluteAsset(a: Asset): Asset {
  return { ...a, url: abs(a.url), thumb_url: abs(a.thumb_url), bundle_url: abs(a.bundle_url) };
}

export function absoluteDetail(d: AssetDetail): AssetDetail {
  return { ...d, asset: absoluteAsset(d.asset), versions: d.versions.map((v) => ({ ...v, thumb_url: abs(v.thumb_url) })) };
}
