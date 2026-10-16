/**
 * Outbound webhook delivery. After an event is written, `dispatchEvent` finds the active hooks whose project and event
 * filters match and POSTs one JSON document to each, signed with the hook's secret:
 *
 *   X-Relay-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Relay-Timestamp>.<raw body>")>
 *   X-Relay-Timestamp: <unix seconds>
 *   X-Relay-Event:     <event kind>
 *   X-Relay-Delivery:  <delivery id, also the webhook_deliveries row>
 *   Authorization:     Bearer <bearer>            (only when the hook was created with one)
 *
 * Three attempts with backoff; the delivery row records the outcome. A hook that fails never blocks the write that
 * triggered it: callers run this after the response (web: `after()`), and every error ends in the delivery log.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.ts";
import type { EventRow } from "../db/events.ts";
import { createDelivery, finishDelivery, matchingWebhooks, type WebhookRow } from "../db/webhooks.ts";
import { sleep, ulid } from "../util.ts";

export interface WebhookPayload {
  /** The delivery id (unique per hook and event), so receivers can dedupe retries. */
  id: string;
  kind: string;
  ts: string;
  task_id?: string;
  project: string | null;
  issue?: number;
  pr?: number;
  url?: string;
  summary: string;
  actor: string;
  lane?: string;
  /** The feed row id; absent for test.ping. */
  event_id?: number;
}

export const SIGNATURE_HEADER = "x-relay-signature";
export const TIMESTAMP_HEADER = "x-relay-timestamp";
export const EVENT_HEADER = "x-relay-event";
export const DELIVERY_HEADER = "x-relay-delivery";
/** Receivers should reject timestamps older than this (replay window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, timestamp: string | number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Constant-time check of a received signature; `now` lets tests pin the clock. */
export function verifyWebhookSignature(secret: string, timestamp: string | null | undefined, body: string, signature: string | null | undefined, opts: { now?: number; toleranceSeconds?: number } = {}): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const got = Buffer.from(signature.trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** The document a hook receives for a feed row. */
export function webhookPayload(e: EventRow, deliveryId: string): WebhookPayload {
  const out: WebhookPayload = { id: deliveryId, kind: e.kind, ts: e.ts, project: e.project, summary: e.summary, actor: e.actor, event_id: e.id };
  if (e.repo && e.issue != null) out.task_id = `${e.repo}#${e.issue}`;
  if (e.issue != null) out.issue = e.issue;
  if (e.pr != null) out.pr = e.pr;
  if (e.url) out.url = e.url;
  if (e.lane) out.lane = e.lane;
  return out;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface DeliverOptions {
  fetch?: FetchLike;
  /** Milliseconds to wait before attempt 2, 3, ...; length + 1 = total attempts (default 3 attempts). */
  backoffMs?: number[];
  timeoutMs?: number;
  now?: () => number;
  /** When set, delivery rows are written here; omit for a dry send (the CLI's test ping without a database). */
  db?: Db;
}

export interface DeliveryResult {
  delivery_id: string;
  webhook_id: string;
  status: "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  error: string | null;
}

export const DEFAULT_BACKOFF_MS = [1000, 4000];

/** POST one payload to one hook with retries; records the delivery when `db` is given. */
export async function deliverWebhook(hook: WebhookRow, payload: WebhookPayload, opts: DeliverOptions = {}): Promise<DeliveryResult> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const now = opts.now ?? Date.now;
  const body = JSON.stringify(payload);
  if (opts.db) await createDelivery(opts.db, { id: payload.id, webhookId: hook.id, eventId: payload.event_id ?? null, kind: payload.kind });
  let attempts = 0;
  let lastStatus: number | null = null;
  let error: string | null = null;
  for (let i = 0; i <= backoff.length; i++) {
    if (i > 0) await sleep(backoff[i - 1]!);
    attempts++;
    const ts = String(Math.floor(now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "relay-webhooks/1",
      [SIGNATURE_HEADER]: signWebhook(hook.secret, ts, body),
      [TIMESTAMP_HEADER]: ts,
      [EVENT_HEADER]: payload.kind,
      [DELIVERY_HEADER]: payload.id,
    };
    if (hook.bearer) headers.authorization = `Bearer ${hook.bearer}`;
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000) : undefined;
      let res: { ok: boolean; status: number };
      try {
        res = await doFetch(hook.url, { method: "POST", headers, body, ...(controller ? { signal: controller.signal } : {}) });
      } finally {
        if (timer) clearTimeout(timer);
      }
      lastStatus = res.status;
      if (res.ok) {
        error = null;
        if (opts.db) await finishDelivery(opts.db, payload.id, { status: "delivered", attempts });
        return { delivery_id: payload.id, webhook_id: hook.id, status: "delivered", attempts, last_status: lastStatus, error: null };
      }
      error = `HTTP ${res.status}`;
      // 4xx other than 408/429 will not get better with a retry
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  if (opts.db) await finishDelivery(opts.db, payload.id, { status: "failed", attempts, error });
  return { delivery_id: payload.id, webhook_id: hook.id, status: "failed", attempts, last_status: lastStatus, error };
}

/** Fan one written event out to every matching hook. Never throws; each hook's outcome is in the result. */
export async function dispatchEvent(db: Db, event: EventRow, opts: Omit<DeliverOptions, "db"> = {}): Promise<DeliveryResult[]> {
  let hooks: WebhookRow[];
  try {
    hooks = await matchingWebhooks(db, event.kind, event.project);
  } catch {
    return [];
  }
  if (!hooks.length) return [];
  const results = await Promise.allSettled(hooks.map((h) => deliverWebhook(h, webhookPayload(event, ulid()), { ...opts, db })));
  return results.map((r, i) => (r.status === "fulfilled" ? r.value : { delivery_id: "", webhook_id: hooks[i]!.id, status: "failed" as const, attempts: 0, last_status: null, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }));
}

/** `relay webhook test`: a synthetic `test.ping` so the receiver can check its signature code end to end. */
export function pingPayload(hook: WebhookRow, deliveryId: string = ulid()): WebhookPayload {
  return { id: deliveryId, kind: "test.ping", ts: new Date().toISOString(), project: hook.project, summary: `relay webhook ${hook.id} test ping`, actor: "bot:relay" };
}
