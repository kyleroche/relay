import { NextResponse } from "next/server";
import { getUsage } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Internal: plan meters for the header strip. proxy.ts requires a session for this route (lib/access.ts). */
export async function GET() {
  const usage = await getUsage("5h");
  return NextResponse.json({ windows: usage.windows, at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
