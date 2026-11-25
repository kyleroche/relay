import { NextResponse } from "next/server";
import { planMeters } from "@/lib/board-read";

export const dynamic = "force-dynamic";

/** Internal: plan meters for the header strip, from the workers on the board. proxy.ts requires a session for this route (lib/access.ts). */
export async function GET() {
  return NextResponse.json({ windows: await planMeters(), at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
