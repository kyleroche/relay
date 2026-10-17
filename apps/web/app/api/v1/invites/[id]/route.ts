import { revokeInvite } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: revokeInvite. By id or name; an unredeemed code stops working at once. */
export const DELETE = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const row = await revokeInvite(await getDb(), decodeURIComponent(id));
    if (!row) return problem(404, "Not Found", `No live invite matches '${id}'.`, instance);
    return json({ revoked: row });
  },
  { scope: "tokens:write" },
);
