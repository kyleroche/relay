import { NextResponse, type NextRequest } from "next/server";
import { getFeed } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Internal: live polling for the feed page (unsanitized, same shape as the page).
 * The public, documented API is /api/v1/feed. proxy.ts requires a session for this route (lib/access.ts).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const events = await getFeed({
    project: sp.get("project") ?? undefined,
    lane: sp.get("lane") ?? undefined,
    actor: sp.get("actor") ?? undefined,
    kind: sp.get("kind") ?? undefined,
    after: sp.get("after") ?? undefined,
    before: sp.get("before") ?? undefined,
    limit: Number(sp.get("limit") ?? 100),
  });
  return NextResponse.json({ events }, { headers: { "cache-control": "no-store" } });
}
