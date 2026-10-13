import { NextResponse } from "next/server";
import { getUsage } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Internal: plan meters for the header strip. TODO(auth): scope to the signed-in viewer. */
export async function GET() {
  const usage = await getUsage("5h");
  return NextResponse.json({ windows: usage.windows, at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
