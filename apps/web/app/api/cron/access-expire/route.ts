import { purgeAccess } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { cronRefusal } from "@/lib/cron";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { oauthOptions } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * Retention sweep for the authorization server (docs/SECURITY.md, "Token lifetimes"): device and authorization
 * codes expired for a day, refresh tokens expired for 30 days, and orphan clients the device flow registered that
 * never got a token. `purgeAccess` writes one access.purged feed row when anything was removed. Scheduled by
 * vercel.json (daily) and protected the Vercel way (lib/cron.ts).
 */
export async function GET(req: NextRequest) {
  const refused = cronRefusal(req);
  if (refused) return refused;
  if (dataMode() !== "db") return NextResponse.json({ ok: true, removed: 0, note: "mock mode: nothing to expire" });
  const r = await purgeAccess(await getDb(), oauthOptions());
  return NextResponse.json({ ok: true, removed: r.device_codes + r.auth_codes + r.refresh_tokens + r.clients.length, ...r, at: new Date().toISOString() });
}
