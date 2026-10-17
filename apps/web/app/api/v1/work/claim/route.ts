import { claimServer } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb, readJson, siteGitHub, str } from "@/lib/integrations";
import { strList, workProblem } from "@/lib/work";

export const dynamic = "force-dynamic";

/**
 * operationId: claimWork. Body: { worker_id, lanes?, labels? }. The oldest queued task whose lane the worker serves
 * and whose `lane.labels` it carries, leased for 30 minutes (renewed by the heartbeat). `claim` is null when nothing is
 * claimable. The issue text is included when the site holds a GitHub token; otherwise the worker reads it with gh.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const workerId = str(body.worker_id);
    if (!workerId) return problem(400, "Bad Request", "worker_id is required.", instance, { parameter: "worker_id" });
    try {
      const lanes = strList(body.lanes);
      const labels = strList(body.labels);
      const claim = await claimServer(await getDb(), { worker_id: workerId, ...(lanes ? { lanes } : {}), ...(labels ? { labels } : {}) }, { github: await siteGitHub() });
      return json({ claim });
    } catch (e) {
      return workProblem(e, instance) ?? Promise.reject(e);
    }
  },
  { scope: "work:claim" },
);
