/** The append-only event feed. Every model call, webhook, and runner step is a row; the ledger is a view over it. */
import { type Db, iso, num } from "./client.ts";
import { refreshTaskForEvent } from "./task-state.ts";

export interface EventInput {
  kind: string;
  actor: string;
  summary: string;
  ts?: string | Date;
  project?: string | null;
  repo?: string | null;
  issue?: number | null;
  pr?: number | null;
  lane?: string | null;
  model?: string | null;
  subscription?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  cost_equiv?: number;
  duration_ms?: number | null;
  url?: string | null;
  payload?: Record<string, unknown>;
  /** Idempotency key (e.g. a GitHub delivery id); a repeat write is ignored and returns undefined. */
  dedupe_key?: string | null;
}

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  actor: string;
  project: string | null;
  repo: string | null;
  issue: number | null;
  pr: number | null;
  lane: string | null;
  model: string | null;
  subscription: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_equiv: number;
  duration_ms: number | null;
  summary: string;
  url: string | null;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
}

export interface UsageSummaryRow {
  subscription: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cost_equiv: number;
  /** Average input context per call: fresh tokens plus cache reads. */
  avg_ctx: number;
}

export const EVENT_COLS = "id, ts, kind, actor, project, repo, issue, pr, lane, model, subscription, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, summary, url, payload, dedupe_key";
const cols = EVENT_COLS;
/** Row normaliser shared with the task module. */
export const toEvent = (r: Record<string, unknown>): EventRow => ({
  id: num(r.id),
  ts: iso(r.ts) ?? "",
  kind: r.kind as string,
  actor: r.actor as string,
  project: (r.project as string | null) ?? null,
  repo: (r.repo as string | null) ?? null,
  issue: r.issue == null ? null : num(r.issue),
  pr: r.pr == null ? null : num(r.pr),
  lane: (r.lane as string | null) ?? null,
  model: (r.model as string | null) ?? null,
  subscription: (r.subscription as string | null) ?? null,
  tokens_in: num(r.tokens_in),
  tokens_out: num(r.tokens_out),
  cache_read: num(r.cache_read),
  cache_write: num(r.cache_write),
  cost_equiv: num(r.cost_equiv),
  duration_ms: r.duration_ms == null ? null : num(r.duration_ms),
  summary: r.summary as string,
  url: (r.url as string | null) ?? null,
  payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {}) as Record<string, unknown>,
  dedupe_key: (r.dedupe_key as string | null) ?? null,
});

/**
 * Append one event. With a dedupe_key that already exists nothing is written and undefined is returned. A row that
 * names a task (repo + issue, or a `preview.*` row for a task's PR or branch) refreshes that task's state cache
 * (db/task-state.ts) before returning, so a list or the board read after this call sees the new state.
 */
export async function writeEvent(db: Db, e: EventInput): Promise<EventRow | undefined> {
  const ts = e.ts instanceof Date ? e.ts.toISOString() : e.ts ?? null;
  const r = await db.query(
    `INSERT INTO events (ts, kind, actor, project, repo, issue, pr, lane, model, subscription, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, summary, url, payload, dedupe_key)
     VALUES (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING ${cols}`,
    [
      ts, e.kind, e.actor, e.project ?? null, e.repo ?? null, e.issue ?? null, e.pr ?? null, e.lane ?? null, e.model ?? null, e.subscription ?? null,
      e.tokens_in ?? 0, e.tokens_out ?? 0, e.cache_read ?? 0, e.cache_write ?? 0, e.cost_equiv ?? 0, e.duration_ms ?? null,
      e.summary, e.url ?? null, JSON.stringify(e.payload ?? {}), e.dedupe_key ?? null,
    ],
  );
  if (!r[0]) return undefined;
  const row = toEvent(r[0]);
  await refreshTaskForEvent(db, row);
  return row;
}

export interface ListEventsOpts {
  project?: string;
  kind?: string;
  actor?: string;
  lane?: string;
  /** ISO timestamp; only events at or after it. */
  since?: string;
  /** ISO timestamp; only events strictly older than it (paging backwards). */
  before?: string;
  /** ISO timestamp; only events strictly newer than it (live polling). */
  after?: string;
  limit?: number;
}

export async function listEvents(db: Db, opts: ListEventsOpts = {}): Promise<EventRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (opts.project) add("project = ?", opts.project);
  if (opts.kind) add(opts.kind.endsWith(".") ? "kind LIKE ?" : "kind = ?", opts.kind.endsWith(".") ? opts.kind + "%" : opts.kind);
  if (opts.actor) add("actor = ?", opts.actor);
  if (opts.lane) add("lane = ?", opts.lane);
  if (opts.since) add("ts >= ?::timestamptz", opts.since);
  if (opts.before) add("ts < ?::timestamptz", opts.before);
  if (opts.after) add("ts > ?::timestamptz", opts.after);
  params.push(opts.limit ?? 100);
  const r = await db.query(`SELECT ${cols} FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC, id DESC LIMIT $${params.length}`, params);
  return r.map(toEvent);
}

export interface GitHubDeliveryStats {
  /** GitHub deliveries recorded for the repo (every ingested delivery carries a `github:` dedupe key). */
  count: number;
  last_delivery_at: string | null;
}

/** Has GitHub ever delivered for `owner/name`, and when last: the newest event for the repo with a `github:` dedupe key. */
export async function githubDeliveryStats(db: Db, repoName: string): Promise<GitHubDeliveryStats> {
  const r = await db.query(`SELECT count(*) AS n, max(ts) AS last FROM events WHERE repo = $1 AND dedupe_key LIKE 'github:%'`, [repoName]);
  return { count: num(r[0]?.n), last_delivery_at: iso(r[0]?.last) ?? null };
}

/** Per-subscription totals of step.usage events since an ISO timestamp (reads the `ledger` view). */
export async function usageSummary(db: Db, sinceIso: string): Promise<UsageSummaryRow[]> {
  const r = await db.query(
    `SELECT coalesce(subscription, 'unknown') AS subscription, count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out,
            sum(cache_read) AS cache_read, sum(cost_equiv) AS cost_equiv, avg(tokens_in + cache_read) AS avg_ctx
     FROM ledger WHERE ts >= $1::timestamptz GROUP BY 1 ORDER BY 1`,
    [sinceIso],
  );
  return r.map((x) => ({
    subscription: x.subscription as string,
    calls: num(x.calls),
    tokens_in: num(x.tokens_in),
    tokens_out: num(x.tokens_out),
    cache_read: num(x.cache_read),
    cost_equiv: num(x.cost_equiv),
    avg_ctx: num(x.avg_ctx),
  }));
}

export interface UsageDayRow {
  /** YYYY-MM-DD in UTC. */
  day: string;
  subscription: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cost_equiv: number;
}

/** step.usage totals per UTC day and subscription since an ISO timestamp, oldest first (the usage page's series). */
export async function usageDaily(db: Db, sinceIso: string): Promise<UsageDayRow[]> {
  const r = await db.query(
    `SELECT to_char(date_trunc('day', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, coalesce(subscription, 'unknown') AS subscription,
            count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cache_read) AS cache_read, sum(cost_equiv) AS cost_equiv
     FROM ledger WHERE ts >= $1::timestamptz GROUP BY 1, 2 ORDER BY 1, 2`,
    [sinceIso],
  );
  return r.map((x) => ({
    day: x.day as string,
    subscription: x.subscription as string,
    calls: num(x.calls),
    tokens_in: num(x.tokens_in),
    tokens_out: num(x.tokens_out),
    cache_read: num(x.cache_read),
    cost_equiv: num(x.cost_equiv),
  }));
}
