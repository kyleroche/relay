/**
 * The web app's data interface. Pages and route handlers import from here only.
 *
 * Mode selection (`dataMode`):
 *   RELAY_DATA=mock            -> lib/data-mock.ts, whatever else is set
 *   RELAY_DATA=db              -> lib/data-db.ts over DATABASE_URL, or the embedded PGlite file when it is unset
 *   neither                    -> db when DATABASE_URL is set, else mock
 *
 * TODO(auth): when sign-in lands, these functions take a viewer and the db adapter
 * scopes projects to what that viewer may see. Mock mode stays open.
 */
import { dbSource } from "./data-db.ts";
import { mockSource } from "./data-mock.ts";
import type { AssetListOptions, AssetReview, DataSource, FeedOptions, NewEvent, UsageWindow } from "./types.ts";

export { SITE_URL, REPO_URL } from "./site.ts";

export type DataMode = "mock" | "db";

export function dataMode(): DataMode {
  const explicit = process.env.RELAY_DATA;
  if (explicit === "db") return "db";
  if (explicit === "mock") return "mock";
  return process.env.DATABASE_URL ? "db" : "mock";
}

function source(): DataSource {
  return dataMode() === "db" ? dbSource : mockSource;
}

export const getFeed = (opts?: FeedOptions) => source().getFeed(opts);
export const getProjects = () => source().getProjects();
export const getProject = (slug: string) => source().getProject(slug);
export const getUsage = (window: UsageWindow) => source().getUsage(window);
export const getWorkers = () => source().getWorkers();
export const getModels = () => source().getModels();
export const writeEvent = (event: NewEvent) => source().writeEvent(event);
export const getAssets = (opts?: AssetListOptions) => source().getAssets(opts);
export const getAsset = (id: string) => source().getAsset(id);
export const reviewAsset = (id: string, review: AssetReview) => source().reviewAsset(id, review);
export const publishAsset = (id: string, by: string) => source().publishAsset(id, by);

/** True when unauthenticated reads of /api/v1/* are allowed. Defaults on in mock mode. */
export function publicReadEnabled(): boolean {
  const v = process.env.RELAY_PUBLIC_READ;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return dataMode() === "mock";
}
