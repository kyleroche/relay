import { api, json, problem } from "@/lib/api";
import { getProject } from "@/lib/data";
import { sanitizeEvent } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/** operationId: getProject */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { slug } = await ctx.params;
    const p = await getProject(slug);
    if (!p) return problem(404, "Not Found", `No project with slug '${slug}'.`, req.nextUrl.pathname);
    return json({ ...p, events: p.events.slice(0, 50).map(sanitizeEvent) });
  },
  { scope: "feed:read" },
);
