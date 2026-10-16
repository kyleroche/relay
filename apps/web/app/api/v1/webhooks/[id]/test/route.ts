import { deliverWebhook, pingPayload, repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: testWebhook. Sends a signed `test.ping` now and returns the delivery result (the response waits for it). */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const db = await getDb();
    const hook = await repo.getWebhook(db, id);
    if (!hook) return problem(404, "Not Found", `No webhook ${id}.`, instance);
    const result = await deliverWebhook(hook, pingPayload(hook), { db, backoffMs: [500, 1500], timeoutMs: 8000 });
    return json(result, { status: result.status === "delivered" ? 200 : 502 });
  },
  { scope: "webhooks:write" },
);
