/**
 * The web app's data interface. Pages and route handlers import from here only.
 *
 * RELAY_DATA=mock (default when DATABASE_URL is unset) serves lib/mock.ts.
 * RELAY_DATA=db, or any DATABASE_URL, selects lib/data-db.ts (TODO(db): not wired yet).
 *
 * TODO(auth): when sign-in lands, these functions take a viewer and the db adapter
 * scopes projects to what that viewer may see. Mock mode stays open.
 */
import { dbSource } from "./data-db.ts";
import { mockSource } from "./data-mock.ts";
import type { DataSource, FeedOptions, NewEvent, UsageWindow } from "./types.ts";

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

/** True when unauthenticated reads of /api/v1/* are allowed. Defaults on in mock mode. */
export function publicReadEnabled(): boolean {
  const v = process.env.RELAY_PUBLIC_READ;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return dataMode() === "mock";
}

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://harness.kyro.house").replace(/\/$/, "");
export const REPO_URL = "https://github.com/kyroche/relay"; // placeholder until the repo is public
