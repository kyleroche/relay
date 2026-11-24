/**
 * The wire between a relay site and relay's lead (`apps/lead`): one POST that wakes the lead about a task that changed
 * in a way worth a decision. The site calls `wakeLead`; the lead's route validates the same body with `parseLeadWake`,
 * so the two ends cannot drift apart.
 *
 * This file imports nothing from the rest of core on purpose: the lead imports it alone
 * (`@relay/core/lead/client.ts`), and anything it pulled in would land in the lead's bundle.
 *
 * Who may call is not decided here. The lead verifies the bearer as a Vercel OIDC token of the site's own project;
 * `token` is that token (`getVercelOidcToken()` from `@vercel/oidc` on the site), never a relay token.
 */
import { createHash } from "node:crypto";

/** Where the lead's wake route answers, under the lead's own origin. */
export const LEAD_WAKE_PATH = "/relay/wake";

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
  /** The calling deployment's Vercel OIDC token. */
  token: string;
  fetch?: typeof fetch;
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

/** The lead's base URL without a trailing slash, or undefined when it is not somewhere a token may be sent. */
function leadBase(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  // the bearer is a deployment's identity: it goes over TLS, or to this machine
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
  if (!wake.token) return refused("no token to call the lead with");
  const cursor = typeof wake.event?.cursor === "string" ? wake.event.cursor : "";
  const parsed = parseLeadWake({ project: wake.project, task: wake.task, event: wake.event, idempotencyKey: leadWakeKey(cursor) });
  if (!parsed.ok) return refused(parsed.error);

  let res: Response;
  try {
    res = await (wake.fetch ?? fetch)(base + LEAD_WAKE_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${wake.token}`,
        // the same token again, where Vercel's Deployment Protection looks for a trusted caller
        "x-vercel-trusted-oidc-idp-token": wake.token,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(parsed.body),
      // a redirect would carry the token to another origin
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
