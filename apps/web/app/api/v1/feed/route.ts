import { api, json, problem } from "@/lib/api";
import { getFeed } from "@/lib/data";
import { sanitizeEvent } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** operationId: listFeed */
export const GET = api(
  async (req) => {
    const sp = req.nextUrl.searchParams;
    const instance = req.nextUrl.pathname;
    const limitRaw = sp.get("limit");
    const limit = limitRaw == null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return problem(400, "Bad Request", "limit must be an integer between 1 and 200.", instance, { parameter: "limit" });
    }
    for (const p of ["before", "after"] as const) {
      const v = sp.get(p);
      if (v != null && !ISO.test(v)) return problem(400, "Bad Request", `${p} must be an ISO 8601 timestamp.`, instance, { parameter: p });
    }
    const events = await getFeed({
      project: sp.get("project") ?? undefined,
      kind: sp.get("kind") ?? undefined,
      actor: sp.get("actor") ?? undefined,
      lane: sp.get("lane") ?? undefined,
      before: sp.get("before") ?? undefined,
      after: sp.get("after") ?? undefined,
      limit,
    });
    const oldest = events.at(-1)?.ts ?? null;
    return json({
      events: events.map(sanitizeEvent),
      count: events.length,
      next_before: events.length === limit ? oldest : null,
    });
  },
  { scope: "feed:read" },
);
