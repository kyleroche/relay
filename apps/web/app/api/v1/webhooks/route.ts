import { repo } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb, readJson, str } from "@/lib/integrations";

export const dynamic = "force-dynamic";

/** operationId: listWebhooks. Registered hooks (secret and bearer never returned). Query: project. */
export const GET = api(
  async (req) => {
    const refused = needsDb(req.nextUrl.pathname);
    if (refused) return refused;
    const project = str(req.nextUrl.searchParams.get("project"));
    const rows = await repo.listWebhooks(await getDb(), { ...(project ? { project } : {}), includeInactive: true });
    const webhooks = rows.map(repo.publicWebhook);
    return json({ webhooks, count: webhooks.length });
  },
  { scope: "webhooks:write" },
);

/**
 * operationId: createWebhook. Body: { url, events: string[], project?, bearer?, secret? }. The signing secret is
 * generated when absent and returned once, in this response only.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const url = str(body.url);
    if (!url) return problem(400, "Bad Request", "url is required.", instance, { parameter: "url" });
    const badUrl = repo.validateWebhookUrl(url);
    if (badUrl) return problem(400, "Bad Request", badUrl, instance, { parameter: "url" });
    const raw = Array.isArray(body.events) ? body.events : typeof body.events === "string" ? body.events.split(",") : [];
    const events = raw.map((e) => String(e).trim()).filter(Boolean);
    if (!events.length) return problem(400, "Bad Request", `events is required: kinds such as ${repo.WEBHOOK_EVENT_KINDS.slice(0, 4).join(", ")}, a prefix like "run.", or "*".`, instance, { parameter: "events" });
    const project = str(body.project) ?? null;
    const db = await getDb();
    if (project && !(await repo.getProject(db, project))) return problem(404, "Not Found", `No project with slug '${project}'.`, instance);
    const grant = await callerGrant(req);
    const secret = str(body.secret);
    const row = await repo.createWebhook(db, { project, url, events, bearer: str(body.bearer) ?? null, ...(secret ? { secret } : {}), createdBy: grant?.actor ?? "token:unknown" });
    return json({ webhook: repo.publicWebhook(row), secret: row.secret }, { status: 201, headers: { location: `/api/v1/webhooks/${row.id}`, "cache-control": "no-store" } });
  },
  { scope: "webhooks:write" },
);
