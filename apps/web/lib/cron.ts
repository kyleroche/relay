import { timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { problem } from "@/lib/api";

/**
 * The Vercel cron contract (vercel.json): every scheduled call carries `Authorization: Bearer $CRON_SECRET`. Without
 * CRON_SECRET every route refuses, so a deployment cannot be swept by an anonymous GET. Returns the refusal to send,
 * or null when the caller is the scheduler.
 */
export function cronRefusal(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const instance = req.nextUrl.pathname;
  if (!secret) return problem(503, "Service Unavailable", "CRON_SECRET is not configured.", instance);
  const presented = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return problem(401, "Unauthorized", "Bad or missing cron secret.", instance);
  return null;
}
