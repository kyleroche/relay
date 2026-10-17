import { startServer } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { needsDb, readJson, str } from "@/lib/integrations";
import { taskIdFrom, workProblem } from "@/lib/work";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ owner: string; task: string }> };

/**
 * operationId: startWork. Path: /work/{owner}/{repo}%23{issue}/start. Body: { worker_id, branch?, host? }. Writes
 * run.started for the task the worker holds a live claim on (409 otherwise); the task is now `running`.
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const { owner, task } = await ctx.params;
    const id = taskIdFrom(owner, task);
    if (!id) return problem(400, "Bad Request", "task id must be owner/repo#n.", instance, { parameter: "task" });
    const body = await readJson(req);
    const workerId = str(body?.worker_id);
    if (!workerId) return problem(400, "Bad Request", "worker_id is required.", instance, { parameter: "worker_id" });
    try {
      const r = await startServer(await getDb(), id, { worker_id: workerId, ...(str(body?.branch) ? { branch: str(body?.branch)! } : {}), ...(str(body?.host) ? { host: str(body?.host)! } : {}) });
      dispatchAfter(r.events);
      return json({ claim: r.claim, events: r.events.map((e) => ({ id: e.id, kind: e.kind })) });
    } catch (e) {
      return workProblem(e, instance) ?? Promise.reject(e);
    }
  },
  { scope: "work:claim" },
);
