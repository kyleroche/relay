import { repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { dataMode, getUsage } from "@/lib/data";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** operationId: getUsage. Per-subscription step.usage totals since `since` (ISO; default 7 days ago): what `relay usage` prints. */
export const GET = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const sinceRaw = req.nextUrl.searchParams.get("since");
    if (sinceRaw && !ISO.test(sinceRaw)) return problem(400, "Bad Request", "since must be an ISO 8601 timestamp.", instance, { parameter: "since" });
    const since = sinceRaw ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    if (dataMode() !== "db") {
      const u = await getUsage("7d");
      return json({ since: u.since, subscriptions: u.subscriptions });
    }
    const rows = await repo.usageSummary(await getDb(), since);
    return json({ since, subscriptions: rows });
  },
  { scope: "feed:read" },
);
