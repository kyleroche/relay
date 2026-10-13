import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LedgerEntry {
  lane: string;
  model: string;
  provider: string;
  subscription: string; // max | codex | grok | gateway
  project?: string;
  task?: string;
  step?: number;
  tokens_in: number;
  tokens_out: number;
  cache_read?: number;
  cache_write?: number;
  cost_equiv?: number;
  duration_ms: number;
  note?: string;
}

export interface LedgerSummaryRow {
  subscription: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cost_equiv: number;
  avg_ctx: number;
}

/** Append-only sqlite ledger (node:sqlite, no native build). Every model call, including embeddings, lands here with a Gateway-list-price cost equivalent. */
export class Ledger {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      lane TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, subscription TEXT NOT NULL,
      project TEXT, task TEXT, step INTEGER,
      tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
      cost_equiv REAL DEFAULT 0, duration_ms INTEGER NOT NULL, note TEXT
    ); CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts); CREATE INDEX IF NOT EXISTS calls_sub ON calls(subscription, ts);`);
  }

  record(e: LedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO calls (lane, model, provider, subscription, project, task, step, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.lane, e.model, e.provider, e.subscription, e.project ?? null, e.task ?? null, e.step ?? null,
        e.tokens_in, e.tokens_out, e.cache_read ?? 0, e.cache_write ?? 0, e.cost_equiv ?? costEquiv(e), e.duration_ms, e.note ?? null,
      );
  }

  /** Per-subscription totals since an ISO timestamp, plus average input context per call (fresh + cache-read). */
  summary(sinceIso: string): LedgerSummaryRow[] {
    return this.db
      .prepare(
        `SELECT subscription, count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cache_read) AS cache_read,
                sum(cost_equiv) AS cost_equiv, avg(tokens_in + cache_read) AS avg_ctx
         FROM calls WHERE ts >= ? GROUP BY subscription ORDER BY subscription`,
      )
      .all(sinceIso) as unknown as LedgerSummaryRow[];
  }

  close(): void {
    this.db.close();
  }
}

/** Gateway list prices per 1M tokens (2026-09-21). Cost-equivalent lets subscription use and paid use be compared. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "anthropic/claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic/claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "openai/gpt-6-astra": { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  // gpt-6-sol/luna and gpt-5.x Codex-sub models: Gateway list prices not yet recorded; cost_equiv stays 0 until added.
  "xai/grok-4.7": { in: 1.2, out: 3.6, cacheRead: 0.3, cacheWrite: 0 },
  "typesafe-ai/jev": { in: 0.042, out: 0, cacheRead: 0, cacheWrite: 0 },
  "openai/text-embedding-3-small": { in: 0.02, out: 0, cacheRead: 0, cacheWrite: 0 },
};

export function costEquiv(e: LedgerEntry): number {
  const p = PRICES[e.model];
  if (!p) return e.cost_equiv ?? 0;
  return (e.tokens_in * p.in + e.tokens_out * p.out + (e.cache_read ?? 0) * p.cacheRead + (e.cache_write ?? 0) * p.cacheWrite) / 1_000_000;
}
