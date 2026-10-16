import { EXTERNAL_KIND, repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { needsDb, readJson, str, writerActor } from "@/lib/integrations";
import { sanitizeEvent } from "@/lib/sanitize";
import { toFeedEvent } from "@/lib/data-db";

export const dynamic = "force-dynamic";

/**
 * operationId: logEvent. Body: { kind: "external.<x>", project?, summary, url?, cost_equiv?, source? }. The actor is
 * always derived from the credential (bot:<token name>, or human:<login> for a signed-in viewer); a body `actor` is
 * ignored. Only `external.*` kinds are accepted so a bot can never forge a runner or GitHub event.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const kind = str(body.kind);
    const summary = str(body.summary);
    if (!kind || !EXTERNAL_KIND.test(kind)) return problem(400, "Bad Request", "kind must start with 'external.' (letters, digits, dots, dashes).", instance, { parameter: "kind" });
    if (!summary) return problem(400, "Bad Request", "summary is required.", instance, { parameter: "summary" });
    if (summary.length > 500) return problem(400, "Bad Request", "summary must be at most 500 characters.", instance, { parameter: "summary" });
    const url = str(body.url);
    if (url && !/^https?:\/\//.test(url)) return problem(400, "Bad Request", "url must be http(s).", instance, { parameter: "url" });
    const cost = body.cost_equiv === undefined ? 0 : Number(body.cost_equiv);
    if (!Number.isFinite(cost) || cost < 0) return problem(400, "Bad Request", "cost_equiv must be a non-negative number.", instance, { parameter: "cost_equiv" });
    const project = str(body.project) ?? null;
    const db = await getDb();
    if (project && !(await repo.getProject(db, project))) return problem(404, "Not Found", `No project with slug '${project}'.`, instance);
    const source = str(body.source);
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
    const row = await repo.writeEvent(db, { kind, actor: await writerActor(req), project, summary, url: url ?? null, cost_equiv: cost, payload: { ...payload, ...(source ? { source } : {}) } });
    dispatchAfter([row]);
    return json({ event: row ? sanitizeEvent(toFeedEvent(row)) : null }, { status: 201 });
  },
  { scope: "events:write" },
);
