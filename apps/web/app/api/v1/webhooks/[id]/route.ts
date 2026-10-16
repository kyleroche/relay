import { repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: getWebhook. One hook with its last deliveries (never the secret or bearer). */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const db = await getDb();
    const hook = await repo.getWebhook(db, id);
    if (!hook) return problem(404, "Not Found", `No webhook ${id}.`, instance);
    return json({ webhook: repo.publicWebhook(hook), deliveries: await repo.listDeliveries(db, id, 20) });
  },
  { scope: "webhooks:write" },
);

/** operationId: deleteWebhook. */
export const DELETE = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const removed = await repo.deleteWebhook(await getDb(), id);
    if (!removed) return problem(404, "Not Found", `No webhook ${id}.`, instance);
    return json({ removed: id });
  },
  { scope: "webhooks:write" },
);
