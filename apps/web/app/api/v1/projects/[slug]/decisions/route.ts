import { repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { dataMode, getProject } from "@/lib/data";
import { getDb } from "@/lib/db";
import { int } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/** operationId: listProjectDecisions. Decisions newest first, including superseded ones unless `current=1` (what `relay memory history` prints). */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { slug } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const sp = req.nextUrl.searchParams;
    const limit = int(sp.get("limit")) ?? 200;
    if (limit < 1 || limit > 1000) return problem(400, "Bad Request", "limit must be an integer between 1 and 1000.", instance, { parameter: "limit" });
    const current = sp.get("current") === "1" || sp.get("current") === "true";
    if (dataMode() !== "db") {
      const p = await getProject(slug);
      if (!p) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
      return json({ decisions: p.decisions.map((d) => ({ ...d, valid_to: null, superseded_by: null, created_at: d.valid_from })), count: p.decisions.length });
    }
    const db = await getDb();
    if (!(await repo.getProject(db, slug))) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
    const decisions = await repo.listDecisions(db, slug, { limit, ...(current ? { current: true } : {}) });
    return json({ decisions, count: decisions.length });
  },
  { scope: "memory:read" },
);
