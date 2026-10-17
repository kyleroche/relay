/** Outbound webhook registrations and their delivery log (migration 005). The dispatcher is webhooks/dispatch.ts. */
import { randomBytes } from "node:crypto";
import { type Db, iso, num } from "./client.ts";
import { ulid } from "../util.ts";

export interface WebhookRow {
  id: string;
  /** null = every project */
  project: string | null;
  url: string;
  secret: string;
  bearer: string | null;
  events: string[];
  active: boolean;
  created_by: string;
  created_at: string;
}

/** What the API and the CLI list: never the secret or the bearer. */
export type PublicWebhook = Omit<WebhookRow, "secret" | "bearer"> & { has_bearer: boolean };

export const publicWebhook = (w: WebhookRow): PublicWebhook => {
  const { secret: _s, bearer, ...rest } = w;
  return { ...rest, has_bearer: !!bearer };
};

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: number | null;
  kind: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

/** Event kinds a hook may subscribe to by name. A hook may also name any other kind, a prefix ending in '.', or '*'. */
export const WEBHOOK_EVENT_KINDS = ["run.finished", "run.failed", "pr.review", "pr.merged", "asset.uploaded", "asset.reviewed", "task.created", "issue.opened", "pr.opened", "preview.ready", "preview.failed", "decision.captured"] as const;

const cols = "id, project, url, secret, bearer, events, active, created_by, created_at";
const toHook = (r: Record<string, unknown>): WebhookRow => ({
  id: r.id as string,
  project: (r.project as string | null) ?? null,
  url: r.url as string,
  secret: r.secret as string,
  bearer: (r.bearer as string | null) ?? null,
  events: Array.isArray(r.events) ? (r.events as string[]) : [],
  active: !!r.active,
  created_by: (r.created_by as string) ?? "",
  created_at: iso(r.created_at) ?? "",
});

export const generateWebhookSecret = (): string => "whsec_" + randomBytes(32).toString("base64url");

const ipv4 = (host: string): number[] | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
};

/** Lower-cased, without IPv6 brackets; an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, which URL parsing renders as `::ffff:a00:1`) becomes its dotted quad. */
const bareHost = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
  if (!mapped) return host;
  if (mapped[1]) return mapped[1];
  const hi = parseInt(mapped[2]!, 16);
  const lo = parseInt(mapped[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

/** Loopback: the machine itself. A developer may point a hook here outside production. */
export function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || host === "::") return true;
  const v4 = ipv4(host);
  return !!v4 && v4[0] === 127;
}

/** Link-local, RFC 1918, carrier-grade NAT and unique-local addresses, and `.internal` / `.local` names: never a webhook target. */
export function isPrivateHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true; // fe80::/10, fc00::/7
  const v4 = ipv4(host);
  if (!v4) return false;
  const [a, b] = v4 as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * A webhook must point at a public https endpoint: the dispatcher runs on the site and would otherwise be a way to
 * reach the site's own network (loopback, link-local, RFC 1918, `.internal`, `.local`). Outside production a
 * loopback http URL is allowed so `relay webhook test` works against a local receiver. Returns the reason to refuse,
 * or undefined. DNS is not resolved here: a public name that resolves privately is for the dispatcher to refuse.
 */
export function validateWebhookUrl(url: string, nodeEnv: string | undefined = process.env.NODE_ENV): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "url must be an absolute https URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "url must use https";
  const production = nodeEnv === "production";
  if (isLoopbackHost(u.hostname)) return production ? "url must not point at this machine (loopback)" : undefined;
  if (isPrivateHost(u.hostname)) return "url must not point at a link-local, private or internal network address";
  if (u.protocol !== "https:") return "url must use https (http is allowed for localhost outside production only)";
  return undefined;
}

export async function createWebhook(db: Db, w: { project?: string | null; url: string; events: string[]; secret?: string; bearer?: string | null; createdBy: string }): Promise<WebhookRow> {
  const bad = validateWebhookUrl(w.url);
  if (bad) throw new Error(bad);
  const events = [...new Set(w.events.map((e) => e.trim()).filter(Boolean))];
  if (!events.length) throw new Error("a webhook needs at least one event kind (or '*')");
  const r = await db.query(
    `INSERT INTO webhooks (id, project, url, secret, bearer, events, created_by) VALUES ($1, $2, $3, $4, $5, $6::text[], $7) RETURNING ${cols}`,
    [ulid(), w.project ?? null, w.url, w.secret ?? generateWebhookSecret(), w.bearer ?? null, events, w.createdBy],
  );
  return toHook(r[0]!);
}

export async function getWebhook(db: Db, id: string): Promise<WebhookRow | undefined> {
  const r = await db.query(`SELECT ${cols} FROM webhooks WHERE id = $1`, [id]);
  return r[0] ? toHook(r[0]) : undefined;
}

export async function listWebhooks(db: Db, opts: { project?: string; includeInactive?: boolean } = {}): Promise<WebhookRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push("active");
  if (opts.project) {
    params.push(opts.project);
    where.push(`(project IS NULL OR project = $${params.length})`);
  }
  const r = await db.query(`SELECT ${cols} FROM webhooks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`, params);
  return r.map(toHook);
}

/** Active hooks that want `kind` for `project`: exact kind, a prefix ending in '.', or '*'. */
export async function matchingWebhooks(db: Db, kind: string, project: string | null | undefined): Promise<WebhookRow[]> {
  const all = await listWebhooks(db, project ? { project } : {});
  return all.filter((h) => (project || h.project === null) && h.events.some((e) => e === "*" || e === kind || (e.endsWith(".") && kind.startsWith(e))));
}

export async function deleteWebhook(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM webhooks WHERE id = $1 RETURNING id`, [id]);
  return r.length > 0;
}

const dcols = "id, webhook_id, event_id, kind, status, attempts, last_error, delivered_at, created_at";
const toDelivery = (r: Record<string, unknown>): DeliveryRow => ({
  id: r.id as string,
  webhook_id: r.webhook_id as string,
  event_id: r.event_id == null ? null : num(r.event_id),
  kind: (r.kind as string) ?? "",
  status: r.status as DeliveryRow["status"],
  attempts: num(r.attempts),
  last_error: (r.last_error as string | null) ?? null,
  delivered_at: iso(r.delivered_at),
  created_at: iso(r.created_at) ?? "",
});

export async function createDelivery(db: Db, d: { id: string; webhookId: string; eventId: number | null; kind: string }): Promise<DeliveryRow> {
  const r = await db.query(`INSERT INTO webhook_deliveries (id, webhook_id, event_id, kind) VALUES ($1, $2, $3, $4) RETURNING ${dcols}`, [d.id, d.webhookId, d.eventId, d.kind]);
  return toDelivery(r[0]!);
}

export async function finishDelivery(db: Db, id: string, result: { status: "delivered" | "failed"; attempts: number; error?: string | null }): Promise<void> {
  await db.query(
    `UPDATE webhook_deliveries SET status = $2, attempts = $3, last_error = $4, delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE NULL END WHERE id = $1`,
    [id, result.status, result.attempts, result.error ?? null],
  );
}

export async function listDeliveries(db: Db, webhookId: string, limit = 20): Promise<DeliveryRow[]> {
  const r = await db.query(`SELECT ${dcols} FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`, [webhookId, limit]);
  return r.map(toDelivery);
}
