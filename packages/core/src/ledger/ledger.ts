/**
 * The ledger is not a table of its own: every model call (lanes and embeddings alike) is a `step.usage` event in
 * the feed, and the `ledger` view selects them back out. This class is the thin adapter lane code records through,
 * plus the Gateway list-price table that turns token counts into a cost equivalent.
 */
import type { Db } from "../db/client.ts";
import { writeEvent, usageSummary, type EventRow, type UsageSummaryRow } from "../db/events.ts";

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

export type LedgerSummaryRow = UsageSummaryRow;

export class Ledger {
  constructor(private readonly db: Db) {}

  /** Append one `step.usage` event. Cost defaults to the Gateway list-price equivalent for the model. */
  async record(e: LedgerEntry): Promise<EventRow | undefined> {
    const ctx = e.tokens_in + (e.cache_read ?? 0);
    const payload: Record<string, unknown> = { provider: e.provider };
    if (e.task) payload.task = e.task;
    if (e.step !== undefined) payload.step = e.step;
    if (e.note) payload.note = e.note;
    return writeEvent(this.db, {
      kind: "step.usage",
      actor: `agent:${e.provider}`,
      project: e.project ?? null,
      lane: e.lane,
      model: e.model,
      subscription: e.subscription,
      tokens_in: e.tokens_in,
      tokens_out: e.tokens_out,
      cache_read: e.cache_read ?? 0,
      cache_write: e.cache_write ?? 0,
      cost_equiv: e.cost_equiv ?? costEquiv(e),
      duration_ms: e.duration_ms,
      summary: e.note || `${e.lane} ${e.model}: ${ctx} in, ${e.tokens_out} out, ${e.duration_ms} ms`,
      payload,
    });
  }

  /** Per-subscription totals since an ISO timestamp, plus average input context per call (fresh + cache-read). */
  summary(sinceIso: string): Promise<LedgerSummaryRow[]> {
    return usageSummary(this.db, sinceIso);
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

/**
 * Media models bill per output, not per token: a price per generated image, per second of video or audio, or both.
 * The nodes lane (`lanes/nodes.ts`) prices each output model it recognises from here; a model that is not listed is
 * recorded with `cost_equiv: 0` and `payload.cost_unknown: true`, so the ledger shows the run without inventing a
 * number. Add a row only from the vendor's own price page (the official-sources rule applies to prices too).
 */
export const MEDIA_PRICES: Record<string, { perOutput?: number; perSecond?: number }> = {};

/** The USD cost of `count` outputs totalling `seconds` from a media model, or undefined when the model is not priced. */
export function mediaCost(model: string | null | undefined, usage: { count: number; seconds?: number | null }): number | undefined {
  if (!model) return undefined;
  const p = MEDIA_PRICES[model];
  if (!p) return undefined;
  let cost = 0;
  if (p.perOutput) cost += p.perOutput * usage.count;
  if (p.perSecond && usage.seconds) cost += p.perSecond * usage.seconds;
  return cost;
}
