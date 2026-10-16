import { repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getProject } from "@/lib/data";
import { getDb } from "@/lib/db";
import { needsDb, readJson, str } from "@/lib/integrations";
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

/** operationId: putProject. Body: { repo?, path?, stack?, check_cmd? }. Registers the project or refreshes the fields given (relay link in site mode). */
export const PUT = api<Ctx>(
  async (req, ctx) => {
    const { slug } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    if (!/^[\w.-]{1,100}$/.test(slug)) return problem(400, "Bad Request", "slug must be letters, digits, dots, dashes or underscores.", instance, { parameter: "slug" });
    const body = (await readJson(req)) ?? {};
    const repoName = str(body.repo);
    if (repoName && !/^[\w.-]+\/[\w.-]+$/.test(repoName)) return problem(400, "Bad Request", "repo must be owner/name.", instance, { parameter: "repo" });
    const db = await getDb();
    const existed = !!(await repo.getProject(db, slug));
    await repo.upsertProject(db, { slug, ...(repoName ? { repo: repoName } : {}), ...(str(body.path) ? { path: str(body.path) as string } : {}), ...(str(body.stack) ? { stack: str(body.stack) as string } : {}), ...(str(body.check_cmd) ? { checkCmd: str(body.check_cmd) as string } : {}) });
    return json({ project: await repo.getProject(db, slug), created: !existed }, { status: existed ? 200 : 201 });
  },
  { scope: "projects:write" },
);
