import { NextResponse } from "next/server";
import { getFlow } from "@/lib/data";
import { memoFor } from "@/lib/memo";

export const dynamic = "force-dynamic";

/** How long one snapshot serves every viewer on this instance; the map polls every 5 s, so a tab sees each change within one poll. */
const FLOW_MEMO_MS = 4_000;

/** One snapshot per instance per `FLOW_MEMO_MS`: N open tabs share one computation (lib/memo.ts). */
const snapshot = memoFor(FLOW_MEMO_MS, getFlow);

/**
 * Internal: the flow map's snapshot (components/flow/pipeline-map.tsx polls it every 5 s). Shape in lib/flow.ts:
 * `{ ts, projects, workers, tasks }` with each task's station and the time it got there; `ts` is when the snapshot
 * was computed, which may be up to `FLOW_MEMO_MS` ago. The browser never caches it (`no-store`); the server memoizes
 * it per instance so three viewers cost one query set, not three. proxy.ts requires a session for this route
 * (lib/access.ts), like /api/feed.
 */
export async function GET() {
  return NextResponse.json(await snapshot(), { headers: { "cache-control": "no-store" } });
}
