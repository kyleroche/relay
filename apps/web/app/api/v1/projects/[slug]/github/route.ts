import { repo } from "@relay/core";
import { api, callerGrant, json, problem, requireScope } from "@/lib/api";
import { dataMode, getProject, SITE_URL } from "@/lib/data";
import { getDb } from "@/lib/db";
import { githubApp, githubAppConfig } from "@/lib/github-app";
import { githubStatusFor } from "@/lib/github-status";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * operationId: getProjectGitHub. Will GitHub events for this project's repository reach this site? `app.installed`
 * is the GitHub App's installation discovery for the repo (never cached longer than an hour), `webhook` the GitHub
 * deliveries already recorded for it. `relay link` prints this as its `events` stage; `relay doctor` lists the
 * projects still missing the App. Readable with `feed:read` or `projects:write` (the scope `relay link` holds), or a
 * session.
 */
export const GET = api<Ctx>(async (req, ctx, rate) => {
  const { slug } = await ctx.params;
  const instance = req.nextUrl.pathname;
  const denied = await requireScope(req, "feed:read", instance, rate);
  if (denied) {
    const grant = await callerGrant(req);
    if (!grant?.scopes.includes("projects:write")) return denied;
  }
  if (dataMode() !== "db") {
    const p = await getProject(slug);
    if (!p) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
    return json(await githubStatusFor(p.repo || null, { siteUrl: SITE_URL }));
  }
  const db = await getDb();
  const p = await repo.getProject(db, slug);
  if (!p) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
  const resolved = await githubAppConfig().catch(() => undefined);
  const app = resolved ? await githubApp().catch(() => undefined) : undefined;
  const delivery = p.repo ? await repo.githubDeliveryStats(db, p.repo) : { count: 0, last_delivery_at: null };
  return json(await githubStatusFor(p.repo ?? null, { app, slug: resolved?.slug ?? null, siteUrl: SITE_URL, delivery }));
});
