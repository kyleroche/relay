import { compileBrief, repo, type BriefIssue } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { dataMode, getProject } from "@/lib/data";
import { getDb } from "@/lib/db";
import { int, siteGitHub, str } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const MAX_TOKENS = 3000;
const LANES = new Set(["claude", "codex", "grok"]);

/**
 * operationId: getProjectBrief. The compiled memory envelope for a project (summary, preferences, decisions,
 * guidance) as `relay brief` prints it, for callers that have no CLI: the cloud-lane caller workflow
 * (`relay-cloud.yml`) fetches it on a GitHub-hosted runner and quotes it under the vendor mention.
 *
 * Query: `issue=N` (the GitHub issue; its title and body join the retrieval query when the site holds a GitHub
 * token, otherwise the intent is `implement issue #N`), or `intent=<text>`; optional `lane=claude|codex|grok`
 * (lane-scoped preferences), `model=<id>` (vendor guidance), `max_tokens` (200..3000, default 3000).
 */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { slug } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const sp = req.nextUrl.searchParams;
    const issueNo = int(sp.get("issue"));
    if (sp.get("issue") !== null && (issueNo === undefined || issueNo < 1)) return problem(400, "Bad Request", "issue must be a positive integer.", instance, { parameter: "issue" });
    const intentParam = str(sp.get("intent"));
    if (!issueNo && !intentParam) return problem(400, "Bad Request", "Pass issue=N or intent=<text>.", instance, { parameter: "intent" });
    const maxTokens = int(sp.get("max_tokens")) ?? MAX_TOKENS;
    if (maxTokens < 200 || maxTokens > MAX_TOKENS) return problem(400, "Bad Request", `max_tokens must be an integer between 200 and ${MAX_TOKENS}.`, instance, { parameter: "max_tokens" });
    const lane = str(sp.get("lane"));
    if (lane && !LANES.has(lane)) return problem(400, "Bad Request", "lane must be claude, codex or grok.", instance, { parameter: "lane" });
    const model = str(sp.get("model"));

    if (dataMode() !== "db") {
      // Mock deployments have no memory; answer the shape with an empty envelope so callers degrade the same way.
      const p = await getProject(slug);
      if (!p) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
      return json({ slug, text: "", tokens: 0, sections: [], omitted: ["preferences", "decisions", "summary", "guidance"], issue: issueNo ?? null });
    }

    const db = await getDb();
    const project = await repo.getProject(db, slug);
    if (!project) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);

    let issue: BriefIssue | undefined;
    if (issueNo) {
      issue = { number: issueNo, title: `issue #${issueNo}` };
      const gh = await siteGitHub();
      if (gh && project.repo) {
        try {
          const i = await gh.getIssue(project.repo, issueNo);
          issue = { number: issueNo, title: i.title || issue.title, body: (i.body ?? "").slice(0, 6000) };
        } catch {
          /* the brief still compiles from the intent alone */
        }
      }
    }
    const intent = intentParam ?? `implement issue #${issueNo}`;
    const b = await compileBrief(db, { project: slug, intent, maxTokens, ...(issue ? { issue } : {}), ...(lane ? { lane } : {}), ...(model ? { model } : {}) });
    return json({ slug, text: b.text, tokens: b.tokens, sections: b.sections, omitted: b.omitted, issue: issueNo ?? null, intent });
  },
  { scope: "memory:read" },
);
