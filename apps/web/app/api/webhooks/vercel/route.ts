import { NextResponse, type NextRequest } from "next/server";
import { problem } from "@/lib/api";
import { writeEvent } from "@/lib/data";
import { dispatchAfter } from "@/lib/dispatch";
import { normalizeVercel } from "@/lib/webhooks/vercel";
import { verifyVercel } from "@/lib/webhooks/verify";

export const dynamic = "force-dynamic";

/**
 * Vercel webhook ingest. Create the webhook in the team settings with the deployment.*
 * events; its secret goes in VERCEL_WEBHOOK_SECRET. Idempotent on the webhook id.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) return problem(503, "Service Unavailable", "VERCEL_WEBHOOK_SECRET is not configured.", "/api/webhooks/vercel");

  const raw = await req.text();
  if (!verifyVercel(raw, req.headers.get("x-vercel-signature"), secret)) {
    return problem(401, "Unauthorized", "Signature mismatch.", "/api/webhooks/vercel");
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return problem(400, "Bad Request", "Body is not JSON.", "/api/webhooks/vercel");
  }

  const event = normalizeVercel(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true, type: body.type ?? null }, { status: 202 });

  const row = await writeEvent(event);
  dispatchAfter([row]);
  return NextResponse.json({ ok: true, id: row?.id ?? null, kind: event.kind }, { status: 201 });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST Vercel webhook deliveries here. See /docs/api." });
}
