/**
 * `relay link` in site mode runs the Sonnet digest and summary calls on the user's machine (where the Claude login
 * is) and uploads the results. The `step.usage` rows those calls produced come along so the site's ledger counts
 * them; each is deduped on (project, ts, tokens) so a retried upload never double-counts.
 */
import { repo, type Db } from "@relay/core";

export interface UsageItem {
  lane?: unknown;
  model?: unknown;
  subscription?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  cost_equiv?: unknown;
  duration_ms?: unknown;
  summary?: unknown;
  ts?: unknown;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Writes the uploaded usage rows (at most 200 per request); returns how many were new. */
export async function recordUploadedUsage(db: Db, project: string, items: UsageItem[] | undefined): Promise<number> {
  if (!Array.isArray(items) || !items.length) return 0;
  let written = 0;
  for (const u of items.slice(0, 200)) {
    const ts = s(u.ts) && !Number.isNaN(Date.parse(u.ts as string)) ? (u.ts as string) : new Date().toISOString();
    const row = await repo.writeEvent(db, {
      kind: "step.usage",
      actor: "agent:anthropic",
      project,
      lane: s(u.lane) ?? "digest",
      model: s(u.model),
      subscription: s(u.subscription) ?? "max",
      tokens_in: Math.round(n(u.tokens_in)),
      tokens_out: Math.round(n(u.tokens_out)),
      cache_read: Math.round(n(u.cache_read)),
      cache_write: Math.round(n(u.cache_write)),
      cost_equiv: n(u.cost_equiv),
      duration_ms: u.duration_ms == null ? null : Math.round(n(u.duration_ms)),
      summary: (s(u.summary) ?? `${s(u.lane) ?? "digest"} call uploaded by relay link`).slice(0, 300),
      ts,
      payload: { provider: "anthropic", uploaded: true },
      dedupe_key: `usage:${project}:${ts}:${Math.round(n(u.tokens_in))}:${Math.round(n(u.tokens_out))}`,
    });
    if (row) written++;
  }
  return written;
}
