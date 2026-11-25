/**
 * The wire between a relay site and relay's lead (`apps/lead`): one POST that wakes the lead about a task that changed
 * in a way worth a decision. The site calls `wakeLead`; the lead's route validates the same body with `parseLeadWake`,
 * so the two ends cannot drift apart.
 *
 * This file imports nothing from the rest of core on purpose: the lead imports it alone
 * (`@relay/core/lead/client.ts`), and anything it pulled in would land in the lead's bundle.
 *
 * Who may call is a secret the two deployments share and nothing else (`RELAY_LEAD_WAKE_SECRET` on both). The site
 * signs each request with it (`signLeadWake`) and the lead checks the signature (`verifyLeadWake`). The secret proves
 * "this is the site" to the lead and is worth nothing anywhere else: a wake-up carries no bearer token, no relay
 * token, and never the site deployment's own Vercel identity, which is its credential on the team's board.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Where the lead's wake route answers, under the lead's own origin. */
export const LEAD_WAKE_PATH = "/relay/wake";

/** The environment variable both deployments keep the shared secret in. */
export const LEAD_WAKE_SECRET_ENV = "RELAY_LEAD_WAKE_SECRET";
/** A shorter secret is refused on both ends: it is the only thing between the internet and a paid model call. */
export const LEAD_WAKE_SECRET_MIN = 32;
/** Unix seconds at which the site signed the request. */
export const LEAD_WAKE_TIMESTAMP_HEADER = "x-relay-wake-timestamp";
/** `sha256=<hex>`: HMAC-SHA256 with the shared secret over `<timestamp>.<raw body>`. */
export const LEAD_WAKE_SIGNATURE_HEADER = "x-relay-wake-signature";
/** How far the timestamp may be from the lead's clock, either way. */
export const LEAD_WAKE_MAX_SKEW_SECONDS = 300;

/** What happened to the task: the word relay shows for the state it reached. */
export const LEAD_WAKE_KINDS = ["failed", "held", "review"] as const;
export type LeadWakeKind = (typeof LEAD_WAKE_KINDS)[number];

export interface LeadWakeTask {
  /** The board's ID for the task's thread. */
  id: string;
  title?: string;
  lane?: string;
  /** The pull request a task in review waits on. */
  pr_url?: string;
}

export interface LeadWakeEvent {
  kind: LeadWakeKind;
  /** The board's cursor for the event: what makes a repeated wake-up the same wake-up. */
  cursor: string;
  /** Why the task failed or what the gate saw, as the board recorded it. A worker wrote it: data, never instructions. */
  reason?: string;
}

/** The JSON the wake route accepts. */
export interface LeadWakeBody {
  /** The relay project's slug. The lead keeps one session per project, keyed by this. */
  project: string;
  task: LeadWakeTask;
  event: LeadWakeEvent;
  /** `leadWakeKey(event.cursor)`: a redelivered board event must not start a second turn. */
  idempotencyKey: string;
}

export interface LeadWake extends Omit<LeadWakeBody, "idempotencyKey"> {
  /** The lead's origin, such as `https://relay-lead.vercel.app`. */
  url: string;
  /** The secret the site shares with the lead (`RELAY_LEAD_WAKE_SECRET`). It signs the request and is never sent. */
  secret: string;
  fetch?: typeof fetch;
  /** The clock the request is stamped with, in milliseconds. Defaults to `Date.now()`. */
  now?: number;
  /** Defaults to a 10 second timeout: a watcher should not wait on the lead. */
  signal?: AbortSignal;
}

export type LeadWakeResult =
  | { ok: true; status: number; sessionId: string | null; deliveryId: string | null }
  /** `status` is 0 when the call was refused before it was sent, or no response arrived. */
  | { ok: false; status: number; error: string };

/** The slug rule of `board/mapping.ts` and the lane rule of `tasks/lanes.ts`, repeated because this file stands alone. */
const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LANE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX = { id: 200, title: 200, cursor: 2000, reason: 2000, url: 500, key: 256 } as const;
const KEY_PREFIX = "relay-wake:";

/**
 * The idempotency key for a board event. The lead's framework takes keys of 1 to 256 characters, so a cursor that
 * would not fit (or is not plain printable ASCII) is sent as its digest instead.
 */
export function leadWakeKey(cursor: string): string {
  if (cursor.length > 0 && KEY_PREFIX.length + cursor.length <= MAX.key && /^[\x21-\x7e]+$/.test(cursor)) return KEY_PREFIX + cursor;
  return `${KEY_PREFIX}sha256:${createHash("sha256").update(cursor).digest("hex")}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number, shape?: RegExp): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max && (!shape || shape.test(v)) ? v : undefined);

/**
 * Validate a wake body. Returns the body with only the fields relay defines, or the first thing wrong with it. A field
 * this version does not know is dropped, not refused, so a newer site can talk to an older lead; an optional field
 * that is present and wrong is refused, since that is a caller's bug worth hearing about.
 */
export function parseLeadWake(input: unknown): { ok: true; body: LeadWakeBody } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isRecord(input)) return bad("the body must be a JSON object");
  const { task, event } = input;
  const project = text(input.project, 64, PROJECT_SLUG);
  if (!project) return bad("project must be a relay project slug");
  if (!isRecord(task)) return bad("task must be an object");
  const id = text(task.id, MAX.id);
  if (!id) return bad(`task.id must be a string of 1 to ${MAX.id} characters`);
  if (!isRecord(event)) return bad("event must be an object");
  const kind = LEAD_WAKE_KINDS.find((k) => k === event.kind);
  if (!kind) return bad(`event.kind must be one of ${LEAD_WAKE_KINDS.join(", ")}`);
  const cursor = text(event.cursor, MAX.cursor);
  if (!cursor) return bad(`event.cursor must be a string of 1 to ${MAX.cursor} characters`);
  const idempotencyKey = text(input.idempotencyKey, MAX.key);
  if (!idempotencyKey) return bad(`idempotencyKey must be a string of 1 to ${MAX.key} characters`);

  const optional: Record<"title" | "lane" | "pr_url" | "reason", string | undefined> = { title: undefined, lane: undefined, pr_url: undefined, reason: undefined };
  const checks = [
    ["title", "task.title", task.title, MAX.title, undefined],
    ["lane", "task.lane", task.lane, 32, LANE],
    ["pr_url", "task.pr_url", task.pr_url, MAX.url, /^https:\/\//],
    ["reason", "event.reason", event.reason, MAX.reason, undefined],
  ] as const;
  for (const [key, name, value, max, shape] of checks) {
    if (value === undefined || value === null) continue;
    const v = text(value, max, shape);
    if (!v) return bad(`${name} is not valid`);
    optional[key] = v;
  }

  return {
    ok: true,
    body: {
      project,
      task: { id, ...(optional.title ? { title: optional.title } : {}), ...(optional.lane ? { lane: optional.lane } : {}), ...(optional.pr_url ? { pr_url: optional.pr_url } : {}) },
      event: { kind, cursor, ...(optional.reason ? { reason: optional.reason } : {}) },
      idempotencyKey,
    },
  };
}

/**
 * The shared secret as an environment gives it, or why it cannot be used. Both ends read it through here, so a secret
 * one end accepts the other does too.
 */
export function leadWakeSecret(raw: string | undefined): { ok: true; secret: string } | { ok: false; error: string } {
  const secret = raw?.trim();
  if (!secret) return { ok: false, error: `${LEAD_WAKE_SECRET_ENV} is not set` };
  if (secret.length < LEAD_WAKE_SECRET_MIN) return { ok: false, error: `${LEAD_WAKE_SECRET_ENV} must be at least ${LEAD_WAKE_SECRET_MIN} characters` };
  return { ok: true, secret };
}

const SIGNATURE_PREFIX = "sha256=";

/** The signature header's value for a body sent at `timestamp` (Unix seconds). `rawBody` is the exact text sent. */
export function signLeadWake(secret: string, timestamp: number | string, rawBody: string): string {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export interface LeadWakeSigned {
  secret: string;
  /** The two headers as they arrived; null when one is missing. */
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** The body exactly as it arrived, before any parsing. */
  rawBody: string;
  /** The verifier's clock in milliseconds. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Whether a request was signed by a holder of the secret, at a time within five minutes of the verifier's clock. The
 * signature is compared in constant time and before the timestamp is judged, so only a holder of the secret is ever
 * told its clock is off. A request replayed inside the window is the same wake-up: its idempotency key is in the
 * signed body.
 */
export function verifyLeadWake(signed: LeadWakeSigned): { ok: true } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const { timestamp, signature } = signed;
  if (!timestamp || !signature) return bad(`a wake-up carries ${LEAD_WAKE_TIMESTAMP_HEADER} and ${LEAD_WAKE_SIGNATURE_HEADER}`);
  if (!/^[0-9]{1,12}$/.test(timestamp)) return bad(`${LEAD_WAKE_TIMESTAMP_HEADER} must be Unix seconds`);
  const expected = Buffer.from(signLeadWake(signed.secret, timestamp, signed.rawBody));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return bad("the signature does not match");
  const skew = Math.abs(Math.floor((signed.now ?? Date.now()) / 1000) - Number(timestamp));
  if (skew > LEAD_WAKE_MAX_SKEW_SECONDS) return bad(`the timestamp is more than ${LEAD_WAKE_MAX_SKEW_SECONDS / 60} minutes from this clock`);
  return { ok: true };
}

/** The lead's base URL without a trailing slash, or undefined when it is not somewhere a wake-up may be sent. */
function leadBase(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  // a task's title and a signature good for five minutes go over TLS, or to this machine
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/**
 * Wake the lead about one task. Never throws: a site calls this from the watcher that keeps its feed, and the lead
 * being down must not stop that. The lead answers 202 once its session has the message. What it then decides is its
 * own turn, and shows on the board and in the feed like any other bot's work.
 */
export async function wakeLead(wake: LeadWake): Promise<LeadWakeResult> {
  const refused = (error: string): LeadWakeResult => ({ ok: false, status: 0, error });
  const base = leadBase(wake.url);
  if (!base) return refused("the lead's URL must be https (http only for localhost), without credentials or a query");
  const secret = leadWakeSecret(wake.secret);
  if (!secret.ok) return refused(secret.error);
  const cursor = typeof wake.event?.cursor === "string" ? wake.event.cursor : "";
  const parsed = parseLeadWake({ project: wake.project, task: wake.task, event: wake.event, idempotencyKey: leadWakeKey(cursor) });
  if (!parsed.ok) return refused(parsed.error);

  // signed as sent: the lead verifies the bytes it received before it parses them
  const body = JSON.stringify(parsed.body);
  const timestamp = String(Math.floor((wake.now ?? Date.now()) / 1000));
  let res: Response;
  try {
    res = await (wake.fetch ?? fetch)(base + LEAD_WAKE_PATH, {
      method: "POST",
      // No authorization header and no Vercel OIDC header: the signature is the whole of who is calling.
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [LEAD_WAKE_TIMESTAMP_HEADER]: timestamp,
        [LEAD_WAKE_SIGNATURE_HEADER]: signLeadWake(secret.secret, timestamp, body),
      },
      body,
      // a redirect would hand the signed request to another origin
      redirect: "error",
      signal: wake.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return refused(`the lead could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  const raw = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : undefined;
  } catch {
    json = undefined;
  }
  const field = (name: string): string | null => (isRecord(json) && typeof json[name] === "string" ? json[name] : null);
  if (!res.ok) return { ok: false, status: res.status, error: field("error") ?? (raw.slice(0, 300) || `HTTP ${res.status}`) };
  return { ok: true, status: res.status, sessionId: field("sessionId"), deliveryId: field("deliveryId") };
}
