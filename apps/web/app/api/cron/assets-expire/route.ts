import { purgeExpiredAssets } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/assets";
import { cronRefusal } from "@/lib/cron";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Retention sweep (docs/ASSETS.md): rows first, then bytes, for rejected and superseded versions past
 * RELAY_ASSET_RETENTION_DAYS. Scheduled by vercel.json (daily) and protected the Vercel way (lib/cron.ts).
 */
export async function GET(req: NextRequest) {
  const refused = cronRefusal(req);
  if (refused) return refused;
  if (dataMode() !== "db") return NextResponse.json({ ok: true, removed: 0, note: "mock mode: nothing to expire" });
  const r = await purgeExpiredAssets(await getDb(), getStore());
  return NextResponse.json({ ok: r.failedKeys.length === 0, removed: r.removed.length, ids: r.removed.map((x) => x.id), failed_keys: r.failedKeys, at: new Date().toISOString() }, { status: r.failedKeys.length ? 207 : 200 });
}
