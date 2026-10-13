import type { HarnessConfig } from "../config.ts";
import type { Ledger } from "../ledger/ledger.ts";

/** Embeds texts through the AI Gateway. Returns null when no Gateway key is configured (full-text search still works). */
export async function embedTexts(texts: string[], cfg: HarnessConfig, ledger?: Ledger, tag?: string): Promise<number[][] | null> {
  if (!cfg.gateway.apiKey) return null;
  const { embedMany } = await import("ai");
  const { createGateway } = await import("@ai-sdk/gateway");
  const gw = createGateway({ apiKey: cfg.gateway.apiKey, headers: { "ai-reporting-user": "relay", "ai-reporting-tags": `relay,onboard${tag ? "," + tag : ""}`.slice(0, 200) } });
  const model = gw.textEmbeddingModel(cfg.gateway.embeddingModel);
  const out: number[][] = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const values = texts.slice(i, i + BATCH);
    const t0 = Date.now();
    const r = await embedMany({ model, values });
    out.push(...r.embeddings);
    await ledger?.record({
      lane: "embed",
      model: cfg.gateway.embeddingModel,
      provider: "gateway",
      subscription: "gateway",
      tokens_in: r.usage?.tokens ?? 0,
      tokens_out: 0,
      duration_ms: Date.now() - t0,
      note: tag ?? "",
    });
  }
  return out;
}
