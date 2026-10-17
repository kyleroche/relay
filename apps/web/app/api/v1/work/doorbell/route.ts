import { doorbellServer } from "@relay/core";
import { api, json, requireScope } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb } from "@/lib/integrations";
import { strList } from "@/lib/work";

export const dynamic = "force-dynamic";

/**
 * operationId: workDoorbell. Query: lanes? (comma-separated). What an idle worker reads instead of running a claim
 * (docs/WORKERS.md, "The loop"): the queue version, which moves on every write that can change what a claim returns,
 * a count of tasks that look queued for those lanes, and the server time. Two indexed reads, nothing written. Either
 * `work:claim` (a worker) or `feed:read` (a dashboard) opens it. The response is per bearer, so never CDN-cached.
 */
export const GET = api(async (req, _ctx, rate) => {
  const instance = req.nextUrl.pathname;
  const denied = await requireScope(req, "work:claim", instance, rate);
  if (denied && (await requireScope(req, "feed:read", instance, rate))) return denied;
  const refused = needsDb(instance);
  if (refused) return refused;
  const lanes = strList(req.nextUrl.searchParams.get("lanes") ?? undefined);
  const bell = await doorbellServer(await getDb(), lanes?.length ? { lanes } : {});
  return json(bell, { headers: { "cache-control": "private, max-age=0" } });
});
