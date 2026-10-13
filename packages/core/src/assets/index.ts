/** Asset library: store adapters, ingest, and the retention sweep that ties rows and bytes together. */
import type { Db } from "../db/client.ts";
import { expireAssets, listExpiredAssets, type AssetRow, type ExpiredAsset } from "../db/assets.ts";
import type { AssetStore } from "./store.ts";

export * from "./store.ts";
export * from "./media.ts";
export * from "./ingest.ts";
export { AssetNotFoundError, DEFAULT_RETENTION_DAYS, retentionDays } from "../db/assets.ts";
export type { AssetRow, AssetKind, AssetStatus, CreateAssetInput, ListAssetsOpts, ReviewInput, ExpiredAsset } from "../db/assets.ts";

export interface PurgeResult {
  removed: ExpiredAsset[];
  /** Keys whose delete threw; the rows are already gone, so these are orphans to clean by hand. */
  failedKeys: string[];
}

/** Dry run: the rows `purgeExpiredAssets` would remove. */
export const previewExpiredAssets = (db: Db, now: Date = new Date()): Promise<AssetRow[]> => listExpiredAssets(db, now);

/** Delete expired rows, then their bytes and thumbnails from the store. */
export async function purgeExpiredAssets(db: Db, store: AssetStore, now: Date = new Date()): Promise<PurgeResult> {
  const removed = await expireAssets(db, now);
  const failedKeys: string[] = [];
  for (const r of removed) {
    for (const k of r.keys) {
      try {
        await store.delete(k);
      } catch {
        failedKeys.push(k);
      }
    }
  }
  return { removed, failedKeys };
}
