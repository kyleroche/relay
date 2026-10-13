import type { HarnessConfig } from "../config.ts";
import type { GraphClient } from "../graph/client.ts";
import type { Ledger } from "../ledger/ledger.ts";
import * as repo from "../graph/repo.ts";
import { findModelSpec, findProviderSpec, providers, models } from "./registry.ts";
import { crawlModelDocs } from "./crawl.ts";
import { chunkDocument } from "./chunk.ts";
import { classifyChunk } from "./classify.ts";
import { embedTexts } from "./embed.ts";
import { installWellKnownSkill } from "./skills.ts";
import { sha256, type Log, noopLog } from "../util.ts";

export interface Harness {
  cfg: HarnessConfig;
  graph: GraphClient;
  ledger?: Ledger;
}

export interface OnboardReport {
  modelId: string;
  pagesFetched: number;
  pagesChanged: number;
  guidance: number;
  embedded: number;
  skills: string[];
  dropped: string[];
}

/** Seed Provider and Model nodes from the registry (idempotent). */
export async function seedRegistry(h: Harness, log: Log = noopLog): Promise<void> {
  for (const p of providers) await repo.upsertProvider(h.graph, { slug: p.slug, name: p.name, doc_domains: p.docDomains, skill_sources: p.skillSources });
  for (const m of models) await repo.upsertModel(h.graph, { id: m.id, provider: m.provider, lanes: m.lanes, staleDays: h.cfg.staleDays });
  log(`seeded ${providers.length} providers, ${models.length} models`);
}

export class NotOnboardedError extends Error {
  constructor(readonly modelId: string, readonly reason: "unknown" | "never" | "stale") {
    super(`model ${modelId} is not onboarded (${reason}); run: relay onboard ${modelId}`);
    this.name = "NotOnboardedError";
  }
}

/** The gate. Throws unless the model's guidance is present and fresh. */
export async function assertOnboarded(h: Harness, modelId: string): Promise<repo.ModelRow> {
  const m = await repo.getModel(h.graph, modelId);
  if (!m) throw new NotOnboardedError(modelId, "unknown");
  if (!m.onboarded_at) throw new NotOnboardedError(modelId, "never");
  const ageDays = (Date.now() - Date.parse(m.onboarded_at)) / 86_400_000;
  if (ageDays > (m.stale_days ?? h.cfg.staleDays)) throw new NotOnboardedError(modelId, "stale");
  return m;
}

/** Gate that repairs itself: onboard (or refresh) when missing/stale, then return the model row. */
export async function ensureOnboarded(h: Harness, modelId: string, log: Log = noopLog): Promise<repo.ModelRow> {
  try {
    return await assertOnboarded(h, modelId);
  } catch (e) {
    if (!(e instanceof NotOnboardedError)) throw e;
    log(`gate: ${e.message}`);
    await onboardModel(h, modelId, { log });
    return assertOnboarded(h, modelId);
  }
}

export async function onboardModel(h: Harness, modelId: string, opts: { force?: boolean; log?: Log } = {}): Promise<OnboardReport> {
  const log = opts.log ?? noopLog;
  const spec = findModelSpec(modelId);
  if (!spec) throw new Error(`no registry entry for ${modelId}; add it to onboard/registry.ts`);
  const pspec = findProviderSpec(spec.provider);
  if (!pspec) throw new Error(`no provider spec for ${spec.provider}`);
  const provider = await repo.upsertProvider(h.graph, { slug: pspec.slug, name: pspec.name, doc_domains: pspec.docDomains, skill_sources: pspec.skillSources });
  await repo.upsertModel(h.graph, { id: spec.id, provider: spec.provider, lanes: spec.lanes, staleDays: h.cfg.staleDays });

  // 1. official docs
  const { pages, dropped, thin } = await crawlModelDocs(spec, provider.doc_domains, log);
  // A thin fetch of a source that previously had content is treated as transient: keep its chunks, do not prune.
  const keptThin: string[] = [];
  for (const url of thin) {
    const known = await repo.getSource(h.graph, url);
    if (known?.sha256) {
      keptThin.push(url);
      log(`thin fetch of previously good source, keeping ${known.title ?? url}`);
    }
  }
  let changed = 0;
  const kw = spec.crawl.chunkKeywords?.map((k) => k.toLowerCase());
  for (const page of pages) {
    const prev = await repo.touchSource(h.graph, { url: page.url, provider: spec.provider, title: page.title });
    if (prev === page.sha256 && !opts.force) {
      log(`unchanged: ${page.title}`);
      continue;
    }
    const pageRelevant = !kw || kw.some((k) => page.title.toLowerCase().includes(k));
    const chunks = chunkDocument(page.text, { sourceUrl: page.url, pageTitle: page.title })
      .filter((c) => pageRelevant || kw!.some((k) => (c.title + "\n" + c.text).toLowerCase().includes(k)))
      .map((c) => ({ ...c, kind: classifyChunk(c.title, c.text) }));
    const n = await repo.replaceGuidance(h.graph, { modelId: spec.id, provider: spec.provider, sourceUrl: page.url, chunks });
    await repo.finishSource(h.graph, page.etag ? { url: page.url, sha256: page.sha256, etag: page.etag } : { url: page.url, sha256: page.sha256 });
    changed++;
    log(`stored ${n} chunks: ${page.title}`);
  }

  // 2. provider-published skills (also stored as Guidance kind=skill so they are searchable)
  const skills: string[] = [];
  const skillSourceUrls: string[] = [];
  for (const s of spec.skills) {
    try {
      const k = await installWellKnownSkill({ ...s, provider: spec.provider, modelId: spec.id, skillsDir: h.cfg.skillsDir, docDomains: provider.doc_domains, log });
      await repo.upsertSkill(h.graph, { name: k.name, model: spec.id, provider: spec.provider, install_path: k.installPath, version: k.version, sha256: k.sha256, source_url: k.sourceUrl });
      const prev = await repo.touchSource(h.graph, { url: k.sourceUrl, provider: spec.provider, title: `skill:${k.name}` });
      const sha = sha256(k.skillMd);
      if (prev !== sha || opts.force) {
        const chunks = chunkDocument(k.skillMd, { sourceUrl: k.sourceUrl, pageTitle: `skill:${k.name}` }).map((c) => ({ ...c, kind: "skill" as const }));
        await repo.replaceGuidance(h.graph, { modelId: spec.id, provider: spec.provider, sourceUrl: k.sourceUrl, chunks });
        await repo.finishSource(h.graph, { url: k.sourceUrl, sha256: sha });
        log(`stored ${chunks.length} skill chunks: ${k.name} v${k.version}`);
      }
      skills.push(`${k.name}@${k.version}`);
      skillSourceUrls.push(k.sourceUrl);
    } catch (e) {
      log(`skill ${s.name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3. embeddings for anything not yet embedded
  let embedded = 0;
  const pending = await repo.unembeddedGuidance(h.graph, spec.id);
  if (pending.length) {
    const vecs = await embedTexts(pending.map((p) => p.text), h.cfg, h.ledger, `model:${spec.id}`);
    if (vecs) {
      await repo.setEmbeddings(h.graph, pending.map((p, i) => ({ id: p.id, vec: vecs[i]! })));
      embedded = pending.length;
      log(`embedded ${embedded} chunks`);
    } else log(`no AI_GATEWAY_API_KEY: ${pending.length} chunks left un-embedded (full-text search still works)`);
  }

  // sources that fell out of the crawl (renamed, deduped, removed) must not keep stale chunks
  const keep = [...pages.map((p) => p.url), ...skillSourceUrls, ...keptThin];
  const pruned = await repo.pruneGuidance(h.graph, spec.id, keep);
  if (pruned) log(`pruned ${pruned} chunks from stale sources`);

  const guidance = await repo.countGuidance(h.graph, spec.id);
  await repo.markOnboarded(h.graph, spec.id, { guidance, skills: skills.length });
  return { modelId: spec.id, pagesFetched: pages.length, pagesChanged: changed, guidance, embedded, skills, dropped };
}

/** Retrieval used by the context builder: vector when embeddings exist, else full-text. Capped by tokens. */
export async function retrieveGuidance(h: Harness, modelId: string, query: string, opts: { k?: number; maxTokens?: number } = {}): Promise<repo.GuidanceHit[]> {
  const k = opts.k ?? 8;
  const maxTokens = opts.maxTokens ?? 3000;
  let hits: repo.GuidanceHit[] = [];
  if (h.cfg.gateway.apiKey) {
    const v = await embedTexts([query], h.cfg, h.ledger, "retrieve");
    if (v) hits = await repo.vectorSearchGuidance(h.graph, modelId, v[0]!, k);
  }
  if (!hits.length) hits = await repo.textSearchGuidance(h.graph, modelId, query, k);
  const out: repo.GuidanceHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (used + hit.tokens > maxTokens) break;
    out.push(hit);
    used += hit.tokens;
  }
  return out;
}
