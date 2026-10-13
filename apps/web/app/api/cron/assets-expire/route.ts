import { timingSafeEqual } from "node:crypto";
import { purgeExpiredAssets } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { problem } from "@/lib/api";
import { getStore } from "@/lib/assets";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Retention sweep (docs/ASSETS.md): rows first, then bytes, for rejected and superseded versions past
 * RELAY_ASSET_RETENTION_DAYS. Scheduled by vercel.json (daily) and protected the Vercel way: the cron sends
 * `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET the route refuses every call.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const instance = req.nextUrl.pathname;
  if (!secret) return problem(503, "Service Unavailable", "CRON_SECRET is not configured.", instance);
  const presented = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return problem(401, "Unauthorized", "Bad or missing cron secret.", instance);
  if (dataMode() !== "db") return NextResponse.json({ ok: true, removed: 0, note: "mock mode: nothing to expire" });
  const r = await purgeExpiredAssets(await getDb(), getStore());
  return NextResponse.json({ ok: r.failedKeys.length === 0, removed: r.removed.length, ids: r.removed.map((x) => x.id), failed_keys: r.failedKeys, at: new Date().toISOString() }, { status: r.failedKeys.length ? 207 : 200 });
}
