import { repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: revokeToken. By id or name; the site stops accepting the token at once. */
export const DELETE = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const row = await repo.revokeToken(await getDb(), decodeURIComponent(id));
    if (!row) return problem(404, "Not Found", `No live token matches '${id}'.`, instance);
    return json({ revoked: row });
  },
  { scope: "tokens:write" },
);
