import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { compileBrief, mergedPreferences, renderRulesFile, RULES_FILE_TOKENS } from "../src/brief/index.ts";
import { approxTokens } from "../src/util.ts";

let db: Db;
const summary = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the project summary. `.repeat(12).trim()).join("\n\n"); // ≈ 1.1K tokens

beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
  await repo.setProjectSummary(db, "demo", summary, approxTokens(summary));
  await repo.upsertProject(db, { slug: "other", path: "/tmp/other" });
  for (let i = 0; i < 30; i++) await repo.addDecision(db, { project: "demo", text: `Decision ${i}: we use approach ${i} for the parser because reason ${i}`, source: "human" });
  await repo.addDecision(db, { project: "other", text: "Other project uses a different parser because it is separate", source: "human" });
  await repo.addDecision(db, { project: null, text: "Globally we keep pull requests small because review is faster", source: "human" });
  await repo.upsertPreference(db, { key: "test_runner", value: "jest", scope: "global", scope_id: null, reason: null });
  await repo.upsertPreference(db, { key: "test_runner", value: "vitest", scope: "project", scope_id: "demo", reason: "PGlite in-process" });
  await repo.upsertPreference(db, { key: "touch_migrations", value: "never", scope: "lane", scope_id: "grok", reason: null });
  await repo.upsertPreference(db, { key: "commit_style", value: "imperative", scope: "global", scope_id: null, reason: null });
});
afterAll(async () => {
  await db.close();
});

describe("mergedPreferences", () => {
  it("narrower scopes override wider ones, lane prefs only when the lane is given", async () => {
    const p = await mergedPreferences(db, { project: "demo" });
    expect(p.find((x) => x.key === "test_runner")?.value).toBe("vitest");
    expect(p.find((x) => x.key === "touch_migrations")).toBeUndefined();
    const g = await mergedPreferences(db, { project: "demo", lane: "grok" });
    expect(g.find((x) => x.key === "touch_migrations")?.value).toBe("never");
    const o = await mergedPreferences(db, { project: "other" });
    expect(o.find((x) => x.key === "test_runner")?.value).toBe("jest");
  });
});

describe("compileBrief", () => {
  it("includes every section under a generous cap, in a fixed render order", async () => {
    const b = await compileBrief(db, { project: "demo", intent: "parser work", maxTokens: 6000 });
    expect(b.sections.map((s) => s.name)).toEqual(["summary", "preferences", "decisions"]);
    expect(b.omitted).toEqual(["review", "guidance"]); // no issue (so no review notes), no model given
    expect(b.text.indexOf("## Project: demo")).toBeLessThan(b.text.indexOf("## Preferences"));
    expect(b.text).toContain("test_runner = vitest");
    expect(b.text).toContain("Globally we keep pull requests small");
    expect(b.text).not.toContain("Other project uses");
    expect(b.tokens).toBeLessThanOrEqual(6000);
    expect(b.sections.reduce((a, s) => a + s.tokens, 0)).toBeGreaterThanOrEqual(b.tokens - 8);
  });

  it("respects a hard cap and never truncates a section mid-way", async () => {
    for (const cap of [40, 120, 300, 800, 1200]) {
      const b = await compileBrief(db, { project: "demo", intent: "parser work", maxTokens: cap });
      expect(b.tokens).toBeLessThanOrEqual(cap);
      // the summary is atomic: either the whole text is there or none of it
      const hasSummary = b.sections.some((s) => s.name === "summary");
      expect(b.text.includes("Paragraph 12 of the project summary")).toBe(hasSummary);
      expect(b.text.includes("Paragraph 1 of the project summary")).toBe(hasSummary);
      // decision lines are whole
      for (const line of b.text.split("\n").filter((l) => l.startsWith("- Decision"))) expect(line).toMatch(/because reason \d+ \[human\]$/);
      // every considered section is either rendered or reported omitted
      const names = new Set([...b.sections.map((s) => s.name), ...b.omitted]);
      expect([...names].sort()).toEqual(["decisions", "guidance", "preferences", "review", "summary"]);
    }
  });

  it("drops the summary before the preferences when the cap is tight", async () => {
    const b = await compileBrief(db, { project: "demo", intent: "parser work", maxTokens: 200 });
    expect(b.sections.map((s) => s.name)).toContain("preferences");
    expect(b.omitted).toContain("summary");
  });

  it("returns an empty envelope when nothing fits", async () => {
    const b = await compileBrief(db, { project: "demo", intent: "x", maxTokens: 5 });
    expect(b.text).toBe("");
    expect(b.tokens).toBe(0);
    expect(b.sections).toEqual([]);
  });

  it("includes vendor guidance only for a model with chunks", async () => {
    await repo.upsertProvider(db, { slug: "acme", name: "Acme", doc_domains: ["docs.acme.test"], skill_sources: [] });
    await repo.upsertModel(db, { id: "acme/widget-1", provider: "acme", lanes: ["image"], staleDays: 30 });
    await repo.touchSource(db, { url: "https://docs.acme.test/prompting", provider: "acme" });
    await repo.replaceGuidance(db, {
      modelId: "acme/widget-1",
      provider: "acme",
      sourceUrl: "https://docs.acme.test/prompting",
      chunks: [
        { id: "g1", index: 0, title: "Prompting the widget", text: "Describe the scene first, then the camera, then the lighting.", tokens: 14, kind: "prompting" },
        { id: "g2", index: 1, title: "Limits", text: "Maximum duration is ten seconds per clip.", tokens: 9, kind: "limits" },
      ],
    });
    const b = await compileBrief(db, { project: "demo", intent: "describe a scene with lighting", model: "acme/widget-1", maxTokens: 6000 });
    expect(b.sections.map((s) => s.name)).toContain("guidance");
    expect(b.text).toContain("## Vendor guidance for acme/widget-1");
    expect(b.text).toContain("Describe the scene first");
  });
});

describe("renderRulesFile", () => {
  it("stays under 2K tokens with whole paragraphs and names the memory tools", async () => {
    const r = await renderRulesFile(db, "demo");
    expect(r.tokens).toBeLessThanOrEqual(RULES_FILE_TOKENS);
    expect(approxTokens(r.text)).toBe(r.tokens);
    expect(r.text).toContain("# relay rules for demo");
    expect(r.text).toContain("relay_recall");
    expect(r.text).toContain("test_runner = vitest");
    expect(r.text).toContain("## Current decisions");
    expect(r.text).toContain("## Project summary");
    expect(r.text).toContain("acme/demo");
  });

  it("drops summary paragraphs, not sentences, under a tight cap", async () => {
    const r = await renderRulesFile(db, "demo", { maxTokens: 700 });
    expect(r.tokens).toBeLessThanOrEqual(700);
    const paras = r.text.split("## Project summary")[1] ?? "";
    for (const p of paras.split("\n").filter((l) => l.startsWith("Paragraph"))) expect(p.endsWith("summary.")).toBe(true);
  });
});
