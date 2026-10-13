/**
 * Seed registry of providers and models. The graph is the source of truth after `relay init`; this file only
 * seeds it and defines crawl recipes. Rule: only hosts listed in `docDomains` are ever fetched. Community
 * sources are not allowed here; add a domain through a Preference (with a reason) if you must.
 */
export interface ProviderSpec {
  slug: string;
  name: string;
  docDomains: string[];
  /** Base URLs that expose /.well-known/agent-skills/index.json */
  skillSources: string[];
}

export interface ModelSpec {
  id: string;
  provider: string;
  lanes: string[];
  /** Pages always fetched. */
  seedUrls: string[];
  crawl: {
    /** Only follow links whose pathname matches. */
    include: RegExp;
    /** Follow a link only if its URL or anchor text contains one of these (lowercase). */
    keywords: string[];
    maxPages: number;
    /** Keep a chunk only if the page title, chunk title or chunk text mentions one of these (lowercase). Omit to keep all. */
    chunkKeywords?: string[];
  };
  /** Provider-published skills to install: well-known source + skill name. */
  skills: Array<{ source: string; name: string }>;
}

export const providers: ProviderSpec[] = [
  {
    slug: "bytedance",
    name: "ByteDance / BytePlus ModelArk",
    docDomains: ["docs.byteplus.com", "arkdocs-en.tos-ap-southeast-1.volces.com", "seed.bytedance.com", "www.volcengine.com"],
    skillSources: ["https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/"],
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    docDomains: ["docs.claude.com", "docs.anthropic.com", "platform.claude.com", "github.com/anthropics"],
    skillSources: [],
  },
  {
    slug: "openai",
    name: "OpenAI",
    docDomains: ["platform.openai.com", "developers.openai.com", "cookbook.openai.com", "github.com/openai"],
    skillSources: [],
  },
  { slug: "xai", name: "xAI", docDomains: ["docs.x.ai"], skillSources: [] },
  { slug: "google", name: "Google", docDomains: ["ai.google.dev"], skillSources: [] },
  { slug: "vercel", name: "Vercel", docDomains: ["vercel.com", "ai-sdk.dev"], skillSources: [] },
];

const ark = (id: string) => `https://docs.byteplus.com/en/docs/ModelArk/${id}`;

export const models: ModelSpec[] = [
  {
    id: "bytedance/seedance-2.5",
    provider: "bytedance",
    lanes: ["video"],
    seedUrls: [ark("2607689"), ark("2607688"), ark("2298881"), ark("2291680"), ark("1330310"), ark("1221660")],
    crawl: { include: /^\/(en\/)?docs\/modelark\//i, keywords: ["seedance", "video generation", "prompt"], maxPages: 30, chunkKeywords: ["seedance", "video", "prompt"] },
    skills: [{ source: "https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/", name: "sd25-pe" }],
  },
  {
    id: "bytedance/seedream-5",
    provider: "bytedance",
    lanes: ["image"],
    seedUrls: [ark("1829186"), ark("1330310")],
    crawl: { include: /^\/(en\/)?docs\/modelark\//i, keywords: ["seedream", "image generation", "prompt"], maxPages: 20, chunkKeywords: ["seedream", "image", "prompt"] },
    skills: [],
  },
  {
    id: "anthropic/claude-fable-5-1",
    provider: "anthropic",
    lanes: ["plan", "review"],
    seedUrls: ["https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview", "https://docs.claude.com/en/docs/about-claude/models/overview"],
    crawl: { include: /^\/en\/docs\//i, keywords: ["prompt", "model", "best practice", "context", "cach"], maxPages: 40 },
    skills: [],
  },
  {
    id: "anthropic/claude-opus-5",
    provider: "anthropic",
    lanes: ["review"],
    seedUrls: ["https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview"],
    crawl: { include: /^\/en\/docs\//i, keywords: ["prompt", "best practice"], maxPages: 25 },
    skills: [],
  },
  {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    lanes: ["digest", "triage"],
    seedUrls: ["https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview"],
    crawl: { include: /^\/en\/docs\//i, keywords: ["prompt", "best practice"], maxPages: 25 },
    skills: [],
  },
  {
    id: "xai/grok-4.7",
    provider: "xai",
    lanes: ["code"],
    seedUrls: ["https://docs.x.ai/docs/overview"],
    crawl: { include: /^\/docs\//i, keywords: ["prompt", "guide", "model", "best"], maxPages: 30 },
    skills: [],
  },
  {
    id: "openai/gpt-6-astra",
    provider: "openai",
    lanes: ["3d"],
    seedUrls: ["https://platform.openai.com/docs/guides/prompt-engineering", "https://platform.openai.com/docs/models"],
    crawl: { include: /^\/docs\//i, keywords: ["prompt", "model", "best"], maxPages: 30 },
    skills: [],
  },
];

export function findModelSpec(id: string): ModelSpec | undefined {
  return models.find((m) => m.id === id);
}
export function findProviderSpec(slug: string): ProviderSpec | undefined {
  return providers.find((p) => p.slug === slug);
}
