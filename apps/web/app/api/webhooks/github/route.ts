import { NextResponse, type NextRequest } from "next/server";
import { problem } from "@/lib/api";
import { writeEvent } from "@/lib/data";
import { githubEvents } from "@/lib/webhooks/github";
import { verifyGitHub } from "@/lib/webhooks/verify";

export const dynamic = "force-dynamic";

/**
 * GitHub webhook ingest. Configure the repo (or org) webhook with content type application/json,
 * secret = GITHUB_WEBHOOK_SECRET, events: issues, issue_comment, pull_request, pull_request_review,
 * workflow_run, deployment_status. Replays are idempotent via the delivery id (and the comment id for
 * usage rows). Writes go through the data layer, which in db mode is @relay/core's repo.writeEvent.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return problem(503, "Service Unavailable", "GITHUB_WEBHOOK_SECRET is not configured.", "/api/webhooks/github");

  const raw = await req.text();
  if (!verifyGitHub(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return problem(401, "Unauthorized", "Signature mismatch.", "/api/webhooks/github");
  }
  const eventName = req.headers.get("x-github-event") ?? "";
  const delivery = req.headers.get("x-github-delivery") ?? crypto.randomUUID();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return problem(400, "Bad Request", "Body is not JSON.", "/api/webhooks/github");
  }

  const events = await githubEvents(eventName, payload, delivery);
  if (!events.length) return NextResponse.json({ ok: true, ignored: true, event: eventName, action: payload.action ?? null }, { status: 202 });

  const written = [];
  for (const event of events) {
    const row = await writeEvent(event);
    written.push({ id: row?.id ?? null, kind: event.kind, deduped: row === null });
  }
  return NextResponse.json({ ok: true, events: written }, { status: 201 });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST GitHub webhook deliveries here. See /docs/api." });
}
