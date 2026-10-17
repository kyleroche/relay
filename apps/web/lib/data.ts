/**
 * The web app's data interface. Pages and route handlers import from here only.
 *
 * Mode selection lives in `lib/mode.ts` (`dataMode`, `publicReadEnabled`) and is re-exported here.
 *
 * Sign-in: the viewer is a session (`lib/session.ts`); `proxy.ts` gates the pages and the internal routes, and
 * web-initiated writes are attributed to `human:<login>`. Mock mode runs with a fake `human:demo` session.
 */
import { dbSource } from "./data-db.ts";
import { mockSource } from "./data-mock.ts";
import { dataMode } from "./mode.ts";
import type { AssetListOptions, AssetReview, DataSource, FeedOptions, NewEvent, TaskListOptions, UsageWindow } from "./types.ts";

export { SITE_URL, REPO_URL } from "./site.ts";
export { dataMode, publicReadEnabled, type DataMode } from "./mode.ts";

function source(): DataSource {
  return dataMode() === "db" ? dbSource : mockSource;
}

export const getFeed = (opts?: FeedOptions) => source().getFeed(opts);
export const getProjects = () => source().getProjects();
export const getProject = (slug: string) => source().getProject(slug);
export const getUsage = (window: UsageWindow) => source().getUsage(window);
export const getWorkers = () => source().getWorkers();
export const getTasks = (opts?: TaskListOptions) => source().getTasks(opts);
export const getModels = () => source().getModels();
export const writeEvent = (event: NewEvent) => source().writeEvent(event);
export const getAssets = (opts?: AssetListOptions) => source().getAssets(opts);
export const getAsset = (id: string) => source().getAsset(id);
export const reviewAsset = (id: string, review: AssetReview) => source().reviewAsset(id, review);
export const publishAsset = (id: string, by: string) => source().publishAsset(id, by);
export const getFlow = () => source().getFlow();
