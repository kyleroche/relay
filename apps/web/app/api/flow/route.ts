import { NextResponse } from "next/server";
import { getFlow } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Internal: the flow map's snapshot (components/flow/pipeline-map.tsx polls it every 5 s). Shape in lib/flow.ts:
 * `{ ts, projects, workers, tasks }` with each task's station and the time it got there. proxy.ts requires a
 * session for this route (lib/access.ts), like /api/feed.
 */
export async function GET() {
  const snapshot = await getFlow();
  return NextResponse.json(snapshot, { headers: { "cache-control": "no-store" } });
}
