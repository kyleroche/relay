import { repo } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { problem } from "@/lib/api";
import { dataMode, writeEvent } from "@/lib/data";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { githubApp, githubWebhookSecrets } from "@/lib/github-app";
import type { NewEvent } from "@/lib/types";
import { githubEvents } from "@/lib/webhooks/github";
import { installationEvents, isInstallationEvent } from "@/lib/webhooks/github-app";
import { senderMayOpenTasks } from "@/lib/webhooks/usage";
import { verifyGitHub } from "@/lib/webhooks/verify";

export const dynamic = "force-dynamic";

/**
 * GitHub webhook ingest, for an organization webhook or the GitHub App's own deliveries (same HMAC; app deliveries
 * carry an `installation` field). Configure with content type application/json, secret = GITHUB_WEBHOOK_SECRET (or
 * the secret the manifest flow stored), events: issues, issue_comment, pull_request, pull_request_review,
 * workflow_run, deployment_status; the app also sends installation and installation_repositories, which become
 * project.github_connected / project.github_disconnected rows and may register a project when relay.md is present.
 * Replays are idempotent via the delivery id (and the comment id for usage rows).
 */
export async function POST(req: NextRequest) {
  const secrets = await githubWebhookSecrets();
  if (!secrets.length) return problem(503, "Service Unavailable", "GITHUB_WEBHOOK_SECRET is not configured and no GitHub App is stored.", "/api/webhooks/github");

  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!secrets.some((s) => verifyGitHub(raw, signature, s))) {
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

  let events;
  let registered: string[] = [];
  if (isInstallationEvent(eventName)) {
    if (dataMode() !== "db") return NextResponse.json({ ok: true, ignored: true, event: eventName, reason: "mock mode" }, { status: 202 });
    const outcome = await installationEvents(eventName, payload, delivery, { db: await getDb(), app: await githubApp().catch(() => undefined) });
    events = outcome.events;
    registered = outcome.registered;
  } else {
    events = await githubEvents(eventName, payload, delivery);
  }
  if (!events.length) return NextResponse.json({ ok: true, ignored: true, event: eventName, action: payload.action ?? null }, { status: 202 });

  const written = [];
  const rows = [];
  for (const event of events) {
    const row = await writeEvent(event);
    rows.push(row);
    written.push({ id: row?.id ?? null, kind: event.kind, deduped: row === null });
  }
  dispatchAfter(rows);
  await Promise.all(events.map((e) => recordLabelledTask(e)));
  return NextResponse.json({ ok: true, events: written, ...(registered.length ? { registered } : {}) }, { status: 201 });
}

/**
 * An `agent:<lane>` label put on an issue by hand (docs/WORKERS.md): the issue becomes a task row so a worker can
 * claim it, exactly as if it had been opened through `relay task create`. Only repos linked as a project count, and
 * only when the login that added the label is in `RELAY_ALLOWED_SENDERS` (`senderMayOpenTasks`; an unset allowlist
 * refuses): anyone with triage on the repo can add a label, and a task spends a subscription on a worker.
 */
async function recordLabelledTask(e: NewEvent): Promise<void> {
  if (e.kind !== "issue.labeled" || !e.repo || !e.issue || !e.lane || dataMode() !== "db") return;
  try {
    const login = e.actor.replace(/^(human|bot):/, "");
    if (!(await senderMayOpenTasks(e.repo, login))) {
      console.warn(`[relay] ${e.repo}#${e.issue}: label by ${e.actor} ignored; not in RELAY_ALLOWED_SENDERS`);
      return;
    }
    const db = await getDb();
    const project = (await repo.listProjects(db)).find((p) => p.repo === e.repo);
    if (!project) return;
    const title = typeof e.payload?.title === "string" ? e.payload.title : null;
    await repo.createTask(db, { project: project.slug, repo: e.repo, issue: e.issue, createdBy: e.actor, lane: e.lane, title });
  } catch (err) {
    console.error(`[relay] task row for ${e.repo}#${e.issue}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST GitHub webhook deliveries here. See /docs/api." });
}
