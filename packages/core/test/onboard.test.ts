import { describe, it, expect } from "vitest";
import { isOfficial, extractDoc } from "../src/onboard/html.ts";
import { chunkDocument } from "../src/onboard/chunk.ts";
import { classifyChunk } from "../src/onboard/classify.ts";
import { normalizeSiteUrl, siteExtract } from "../src/onboard/extractors.ts";
import { costEquiv, Ledger } from "../src/ledger/ledger.ts";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";

describe("official-source gate", () => {
  const domains = ["docs.byteplus.com", "github.com/anthropics", "arkdocs-en.tos-ap-southeast-1.volces.com"];
  it("accepts exact host and subdomains", () => {
    expect(isOfficial("https://docs.byteplus.com/en/docs/ModelArk/1", domains)).toBe(true);
    expect(isOfficial("https://x.docs.byteplus.com/a", domains)).toBe(true);
  });
  it("rejects look-alike hosts and community sources", () => {
    expect(isOfficial("https://docs.byteplus.com.evil.io/a", domains)).toBe(false);
    expect(isOfficial("https://github.com/dexhunter/seedance2-skill", domains)).toBe(false);
    expect(isOfficial("https://vidmuse.ai/blog/seedance", domains)).toBe(false);
  });
  it("honours path-prefixed entries", () => {
    expect(isOfficial("https://github.com/anthropics/skills", domains)).toBe(true);
    expect(isOfficial("https://github.com/anthropicsx/skills", domains)).toBe(false);
  });
  it("rejects non-http schemes", () => {
    expect(isOfficial("file:///etc/passwd", domains)).toBe(false);
  });
});

describe("byteplus extractor", () => {
  const page = (md: string) =>
    `<html><head><title>BytePlus</title></head><body><nav><a href="/docs/ModelArk/2">Video generation tutorial</a></nav>` +
    `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { page: { curDoc: { Title: "Guide", EnTitle: "Prompt guide", MDContent: md, UpdatedTime: "2026-09-01" } } } })};</script></body></html>`;
  const md = '# Intro\n\nUse 1\\-second intervals.<span id="x"></span>\n\n<div data-tips="true" data-tips-type="tip">be brief</div>\n\n<columns><columnsItem zoneid="z">**Input**</columnsItem></columns>';
  it("reads MDContent, cleans escapes and layout html", () => {
    const d = extractDoc(page(md), "https://docs.byteplus.com/en/docs/ModelArk/1");
    expect(d.title).toBe("Prompt guide");
    expect(d.text).toContain("Use 1-second intervals.");
    expect(d.text).toContain("> be brief");
    expect(d.text).not.toContain("<span");
    expect(d.text).not.toContain("columns");
    expect(d.links[0]?.url).toBe("https://docs.byteplus.com/docs/ModelArk/2");
  });
  it("returns empty text for a shell page so the crawler skips it", () => {
    const x = siteExtract(page(""), "https://docs.byteplus.com/en/docs/ModelArk/1");
    expect(x?.text).toBe("");
    expect(extractDoc(page(""), "https://docs.byteplus.com/en/docs/ModelArk/1").text).toBe("");
  });
  it("normalises /docs to /en/docs and strips hashes", () => {
    expect(normalizeSiteUrl("https://docs.byteplus.com/docs/ModelArk/2#a")).toBe("https://docs.byteplus.com/en/docs/ModelArk/2");
    expect(normalizeSiteUrl("https://docs.claude.com/en/docs/x/")).toBe("https://docs.claude.com/en/docs/x");
  });
});

describe("chunking + classification", () => {
  const text = ["# Limits", "", "Videos: up to 30 seconds, resolution up to 4K.", "", "## Prompting", "", "Describe the shot with timestamps. " + "word ".repeat(1500), "", "```", "curl https://api.example/v1", "```"].join("\n");
  const chunks = chunkDocument(text, { sourceUrl: "https://x/y", pageTitle: "Page", maxTokens: 300 });
  it("keeps heading paths as titles and stays under the cap", () => {
    expect(chunks[0]?.title).toBe("Page > Limits");
    expect(chunks.some((c) => c.title === "Page > Limits > Prompting")).toBe(true);
    expect(Math.max(...chunks.map((c) => c.tokens))).toBeLessThanOrEqual(300);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });
  it("classifies by dominant signal", () => {
    expect(classifyChunk("Page > Limits", "Videos: up to 30 seconds, resolution up to 4K.")).toBe("limits");
    expect(classifyChunk("Page > Prompting", "Describe the shot with timestamps and an example prompt.")).toBe("prompting");
    expect(classifyChunk("Page > Moderation", "Sensitive content policy: prohibited faces.")).toBe("moderation");
  });
});

describe("ledger", () => {
  it("records calls as step.usage events and computes cost equivalents at gateway list price", async () => {
    const db = await openDb({ file: ":memory:" });
    await migrate(db);
    const l = new Ledger(db);
    await l.record({ lane: "plan", model: "anthropic/claude-fable-5-1", provider: "anthropic", subscription: "max", tokens_in: 1_000_000, tokens_out: 0, duration_ms: 1 });
    await l.record({ lane: "code", model: "xai/grok-4.7", provider: "xai", subscription: "grok", tokens_in: 0, tokens_out: 1_000_000, cache_read: 1_000_000, duration_ms: 1 });
    const s = await l.summary("2000-01-01T00:00:00Z");
    expect(s.find((r) => r.subscription === "max")?.cost_equiv).toBeCloseTo(10);
    expect(s.find((r) => r.subscription === "grok")?.avg_ctx).toBe(1_000_000);
    expect(costEquiv({ lane: "x", model: "unknown/model", provider: "?", subscription: "?", tokens_in: 5, tokens_out: 5, duration_ms: 0 })).toBe(0);
    await db.close();
  });
});
