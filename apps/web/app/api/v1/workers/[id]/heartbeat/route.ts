import { heartbeatServer } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { needsDb, readJson, str } from "@/lib/integrations";
import { workProblem } from "@/lib/work";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * operationId: heartbeatWorker. Body: { status?: "online" | "offline" }. Touches last_seen and renews every lease the
 * worker holds (30 minutes from now). `offline` records a clean shutdown as worker.offline.
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const { id } = await ctx.params;
    const body = (await readJson(req)) ?? {};
    const status = str(body.status) as "online" | "offline" | undefined;
    if (status && status !== "online" && status !== "offline") return problem(400, "Bad Request", "status must be online or offline.", instance, { parameter: "status" });
    try {
      const r = await heartbeatServer(await getDb(), decodeURIComponent(id), status ? { status } : {});
      dispatchAfter(r.events);
      return json({ worker: r.worker, leases: r.leases });
    } catch (e) {
      return workProblem(e, instance) ?? Promise.reject(e);
    }
  },
  { scope: "work:claim" },
);
