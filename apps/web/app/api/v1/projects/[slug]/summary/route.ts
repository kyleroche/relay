import { repo, validateSummary } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { int, needsDb, readJson, str } from "@/lib/integrations";
import { recordUploadedUsage, type UsageItem } from "@/lib/project-uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * operationId: putProjectSummary. Body: { summary, tokens?, usage? }. The project brief `relay link` wrote locally
 * (validated the same way: 150-700 words with the five headings), plus the step.usage rows that produced it.
 */
export const PUT = api<Ctx>(
  async (req, ctx) => {
    const { slug } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    const summary = str(body?.summary);
    if (!body || !summary) return problem(400, "Bad Request", "Body must be JSON with a summary.", instance, { parameter: "summary" });
    const problems = validateSummary(summary);
    if (problems.length) return problem(400, "Bad Request", `Summary rejected: ${problems.join("; ")}.`, instance, { parameter: "summary" });
    const db = await getDb();
    if (!(await repo.getProject(db, slug))) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
    const tokens = int(body.tokens) ?? Math.ceil(summary.length / 4);
    await repo.setProjectSummary(db, slug, summary, tokens);
    const usage = await recordUploadedUsage(db, slug, body.usage as UsageItem[] | undefined);
    return json({ slug, tokens, usage });
  },
  { scope: "projects:write" },
);
