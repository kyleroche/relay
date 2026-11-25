/**
 * What one turn of the lead cost, as the feed row relay keeps for it. Every model call relay makes is in its feed; the
 * lead's are the only ones billed per token (through AI Gateway) rather than to a subscription, so they are recorded
 * with the cost the gateway reported, and with no cost when it reported none. Nothing here estimates a price.
 */
import type { RunObservation } from "eve/events";

export interface TurnSpend {
  /** The model ids the turn's runs named, in the order first seen. */
  models: string[];
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when no run reported a cost: unknown, not zero. */
  costUsd: number | null;
}

/** The sum of a turn's model runs, or null when none of them recorded usage. */
export function turnSpend(runs: readonly Pick<RunObservation, "modelId" | "usage">[]): TurnSpend | null {
  const spent: TurnSpend = { models: [], runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
  for (const run of runs) {
    if (!run.usage) continue;
    spent.runs += 1;
    spent.inputTokens += run.usage.inputTokens;
    spent.outputTokens += run.usage.outputTokens;
    spent.cacheReadTokens += run.usage.cacheReadTokens;
    spent.cacheWriteTokens += run.usage.cacheWriteTokens;
    if (run.usage.costUsd !== undefined) spent.costUsd = (spent.costUsd ?? 0) + run.usage.costUsd;
    if (run.modelId && !spent.models.includes(run.modelId)) spent.models.push(run.modelId);
  }
  return spent.runs > 0 ? spent : null;
}

export const USAGE_KIND = "external.lead.usage";

/** The arguments of the `relay_event_log` call that records a turn's spend. */
export function usageEvent(spent: TurnSpend, project?: string): Record<string, unknown> {
  const cost = spent.costUsd === null ? "cost not reported" : `$${spent.costUsd.toFixed(4)}`;
  const cached = spent.cacheReadTokens > 0 ? ` (${spent.cacheReadTokens} read from cache)` : "";
  const summary = `Lead turn on ${spent.models.join(", ") || "an unnamed model"}: ${spent.runs} model call${spent.runs === 1 ? "" : "s"}, ${spent.inputTokens} input tokens${cached}, ${spent.outputTokens} output tokens, ${cost}`;
  return {
    kind: USAGE_KIND,
    summary: summary.slice(0, 500),
    source: "lead",
    ...(project ? { project } : {}),
    // only a cost the gateway reported is sent; without one the summary says so, since relay stores a missing cost as 0
    ...(spent.costUsd !== null ? { cost_equiv: spent.costUsd } : {}),
  };
}
