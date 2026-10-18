import { forgetWorkerServer } from "@relay/core";
import { api, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { needsDb, writerActor } from "@/lib/integrations";
import { workProblem } from "@/lib/work";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * operationId: forgetWorker. Remove a retired worker's row by id or name (`relay work forget <name>`): the workers
 * page and the board stop showing it. Its claims and run.* events stay, so past runs keep their attribution.
 * 404 for an unknown worker, 409 while it holds a live claim. Writes `worker.forgotten` as the caller. A machine that
 * runs `relay work` again registers a fresh row under the same name. A `work:claim` bearer or the signed-in person.
 */
export const DELETE = api<Ctx>(
  async (req, ctx) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const { id } = await ctx.params;
    const [actor, db] = await Promise.all([writerActor(req), getDb()]);
    try {
      const r = await forgetWorkerServer(db, decodeURIComponent(id), actor);
      dispatchAfter(r.events);
      return json({ forgotten: r.worker });
    } catch (e) {
      return workProblem(e, instance) ?? Promise.reject(e);
    }
  },
  { scope: "work:claim" },
);
