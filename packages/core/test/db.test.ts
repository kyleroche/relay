import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate, currentVersion } from "../src/db/migrate.ts";
import * as projects from "../src/db/projects.ts";
import * as guidance from "../src/db/guidance.ts";
import * as memory from "../src/db/memory.ts";
import * as events from "../src/db/events.ts";

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
});
afterAll(async () => {
  await db.close();
});

describe("migrations", () => {
  it("apply once, then are a no-op", async () => {
    const v1 = await migrate(db);
    const v2 = await migrate(db);
    expect(v1).toBeGreaterThanOrEqual(1);
    expect(v2).toBe(v1);
    expect(await currentVersion(db)).toBe(v1);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
    const names = tables.map((t) => t.table_name);
    for (const t of ["meta", "projects", "file_digests", "decisions", "preferences", "providers", "models", "sources", "guidance", "skills", "events", "ledger"]) expect(names).toContain(t);
  });
  it("boots pgvector", async () => {
    const r = await db.query<{ d: number }>("SELECT '[1,0]'::vector <=> '[0,1]'::vector AS d");
    expect(r[0]?.d).toBeCloseTo(1);
  });
});

describe("projects + file digests", () => {
  it("round-trips a project, its digests, and stale detection", async () => {
    await projects.upsertProject(db, { slug: "demo", path: "/tmp/demo", stack: "ts" });
    await projects.upsertProject(db, { slug: "demo", path: "/tmp/demo2" }); // stack survives coalesce
    const p = await projects.getProject(db, "demo");
    expect(p?.path).toBe("/tmp/demo2");
    expect(p?.stack).toBe("ts");
    expect((await projects.listProjects(db)).map((x) => x.slug)).toContain("demo");

    await projects.upsertFileDigests(db, "demo", [
      { path: "a.ts", sha256: "aaa", size: 10 },
      { path: "b.ts", sha256: "bbb", size: 20 },
    ]);
    expect((await projects.listFileDigests(db, "demo", { staleOnly: true })).length).toBe(2);
    await projects.setFileSummaries(db, "demo", [{ path: "a.ts", summary: "the a file", tokens: 3, sha256: "aaa" }]);
    expect((await projects.listFileDigests(db, "demo", { staleOnly: true })).map((f) => f.path)).toEqual(["b.ts"]);

    // content changed: summary kept, but stale again
    await projects.upsertFileDigests(db, "demo", [{ path: "a.ts", sha256: "aaa2", size: 11 }]);
    const a = (await projects.listFileDigests(db, "demo")).find((f) => f.path === "a.ts");
    expect(a?.summary).toBe("the a file");
    expect(a?.summary_sha).toBe("aaa");
    expect((await projects.listFileDigests(db, "demo", { staleOnly: true })).length).toBe(2);

    expect(await projects.removeMissingFileDigests(db, "demo", ["a.ts"])).toBe(1);
    expect((await projects.listFileDigests(db, "demo")).map((f) => f.path)).toEqual(["a.ts"]);

    await projects.setProjectSummary(db, "demo", "brief", 1);
    expect((await projects.getProject(db, "demo"))?.summary_tokens).toBe(1);
  });
});

describe("guidance", () => {
  const model = "acme/widget-1";
  const url = "https://docs.acme.test/widget";
  const chunk = (i: number, title: string, text: string): guidance.GuidanceChunk => ({ id: `c${i}`, index: i, title, text, tokens: 10, kind: "prompting" });

  it("seeds provider and model, unions provider domains", async () => {
    await guidance.upsertProvider(db, { slug: "acme", name: "Acme", doc_domains: ["docs.acme.test"], skill_sources: [] });
    const p = await guidance.upsertProvider(db, { slug: "acme", name: "Acme Inc", doc_domains: ["help.acme.test"], skill_sources: ["https://acme.test/skills/"] });
    expect(p.doc_domains.sort()).toEqual(["docs.acme.test", "help.acme.test"]);
    expect((await guidance.getProvider(db, "acme"))?.name).toBe("Acme Inc");
    // re-seeding a provider with empty arrays must not turn the union into NULL (relay init runs seedRegistry every time)
    await guidance.upsertProvider(db, { slug: "bare", name: "Bare", doc_domains: [], skill_sources: [] });
    const bare = await guidance.upsertProvider(db, { slug: "bare", name: "Bare", doc_domains: [], skill_sources: [] });
    expect(bare.skill_sources).toEqual([]);
    expect((await guidance.getProvider(db, "bare"))?.doc_domains).toEqual([]);
    await guidance.upsertModel(db, { id: model, provider: "acme", lanes: ["image"], staleDays: 30 });
    await guidance.upsertModel(db, { id: "acme/other", provider: "acme", lanes: [], staleDays: 30 });
    const m = await guidance.getModel(db, model);
    expect(m?.onboarded_at).toBeNull();
    expect(m?.lanes).toEqual(["image"]);
    expect((await guidance.listModels(db)).map((x) => x.id)).toContain(model);
  });

  it("replaces, searches, prunes", async () => {
    expect(await guidance.touchSource(db, { url, provider: "acme", title: "Widget" })).toBeUndefined();
    const n = await guidance.replaceGuidance(db, {
      modelId: model,
      provider: "acme",
      sourceUrl: url,
      chunks: [chunk(0, "Widget > Prompting", "Describe the widget with timestamps and a camera angle."), chunk(1, "Widget > Limits", "Videos up to 30 seconds at 4K resolution.")],
    });
    expect(n).toBe(2);
    await guidance.finishSource(db, { url, sha256: "s1" });
    expect(await guidance.touchSource(db, { url, provider: "acme" })).toBe("s1");
    expect((await guidance.getSource(db, url))?.sha256).toBe("s1");

    // the same source may guide another model without colliding on chunk ids
    await guidance.replaceGuidance(db, { modelId: "acme/other", provider: "acme", sourceUrl: url, chunks: [chunk(0, "Widget > Prompting", "Shared prompting chunk.")] });
    expect(await guidance.countGuidance(db, model)).toBe(2);
    expect(await guidance.countGuidance(db, "acme/other")).toBe(1);

    // full text: AND pass, then OR fill
    const hits = await guidance.textSearchGuidance(db, model, "camera angle", 5);
    expect(hits.map((h) => h.id)).toEqual(["c0"]);
    const loose = await guidance.textSearchGuidance(db, model, "resolution timestamps", 5);
    expect(new Set(loose.map((h) => h.id))).toEqual(new Set(["c0", "c1"]));
    expect(await guidance.textSearchGuidance(db, model, "zebra", 5)).toEqual([]);

    // replacing with fewer chunks drops the rest; replace resets embeddings
    expect((await guidance.unembeddedGuidance(db, model)).length).toBe(2);
    const dim = 1536;
    const unit = (i: number) => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
    await guidance.setEmbeddings(db, [{ id: "c0", vec: unit(0) }, { id: "c1", vec: unit(1) }], model);
    expect((await guidance.unembeddedGuidance(db, model)).length).toBe(0);
    expect((await guidance.unembeddedGuidance(db, "acme/other")).length).toBe(1); // scoped by model
    const near = await guidance.vectorSearchGuidance(db, model, unit(1), 1);
    expect(near[0]?.id).toBe("c1");
    expect(near[0]?.score).toBeCloseTo(0);

    const other = "https://docs.acme.test/old";
    await guidance.touchSource(db, { url: other, provider: "acme" });
    await guidance.replaceGuidance(db, { modelId: model, provider: "acme", sourceUrl: other, chunks: [chunk(9, "Old", "Obsolete page.")] });
    expect(await guidance.countGuidance(db, model)).toBe(3);
    expect(await guidance.pruneGuidance(db, model, [url])).toBe(1);
    expect(await guidance.countGuidance(db, model)).toBe(2);
    expect(await guidance.getSource(db, other)).toBeUndefined(); // orphaned source removed
    expect(await guidance.getSource(db, url)).toBeDefined();

    await guidance.markOnboarded(db, model, { guidance: 2, skills: 0 });
    const m = await guidance.getModel(db, model);
    expect(m?.onboarded_at).toMatch(/^\d{4}-/);
    expect(m?.guidance_count).toBe(2);
  });

  it("stores skills", async () => {
    await guidance.upsertSkill(db, { name: "sk", model, provider: "acme", install_path: "/x", version: "1", sha256: "h", source_url: "https://docs.acme.test/sk.zip" });
    await guidance.upsertSkill(db, { name: "sk", model, provider: "acme", install_path: "/x", version: "2", sha256: "h2", source_url: "https://docs.acme.test/sk.zip" });
    const ks = await guidance.listSkills(db, model);
    expect(ks.length).toBe(1);
    expect(ks[0]?.version).toBe("2");
  });
});

describe("decisions + preferences", () => {
  it("adds, supersedes, lists current, searches", async () => {
    await projects.upsertProject(db, { slug: "mem", path: "/tmp/mem" });
    const d1 = await memory.addDecision(db, { project: "mem", text: "Use PGlite locally and Neon in production.", source: "human" });
    const d2 = await memory.addDecision(db, { project: "mem", text: "Review lane defaults to Opus.", source: "claude", sourceRef: "sess-1" });
    expect((await memory.listDecisions(db, "mem", { current: true })).length).toBe(2);

    const d3 = await memory.supersedeDecision(db, d1.id, { text: "Use Neon everywhere; PGlite only for tests.", source: "pr", sourceRef: "https://github.com/x/y/pull/1" });
    const current = await memory.listDecisions(db, "mem", { current: true });
    expect(current.map((d) => d.id).sort()).toEqual([d2.id, d3.id].sort());
    const all = await memory.listDecisions(db, "mem");
    const old = all.find((d) => d.id === d1.id);
    expect(old?.valid_to).not.toBeNull();
    expect(old?.superseded_by).toBe(d3.id);

    const hits = await memory.searchDecisions(db, "mem", "neon", 5);
    expect(hits.map((h) => h.id)).toEqual([d3.id]); // the superseded one is excluded

    const vecHit = await memory.addDecision(db, { project: "mem", text: "embedded one", embedding: Array.from({ length: 1536 }, (_, j) => (j === 2 ? 1 : 0)) });
    const near = await memory.searchDecisions(db, "mem", Array.from({ length: 1536 }, (_, j) => (j === 2 ? 1 : 0)), 3);
    expect(near[0]?.id).toBe(vecHit.id);
  });

  it("upserts preferences by scope", async () => {
    await memory.upsertPreference(db, { key: "review.model", scope: "global", scope_id: null, value: "opus", reason: null });
    await memory.upsertPreference(db, { key: "review.model", scope: "project", scope_id: "mem", value: "sonnet", reason: "cheap" });
    await memory.upsertPreference(db, { key: "review.model", scope: "global", scope_id: null, value: "fable", reason: "changed" });
    const all = await memory.listPreferences(db);
    expect(all.length).toBe(2);
    expect(all.find((p) => p.scope === "global")?.value).toBe("fable");
    expect((await memory.listPreferences(db, "project", "mem"))[0]?.value).toBe("sonnet");
  });
});

describe("events", () => {
  it("writes with dedupe and summarises usage per subscription", async () => {
    const e1 = await events.writeEvent(db, { kind: "issue.opened", actor: "human:kyle", project: "mem", summary: "Open #1", issue: 1, dedupe_key: "gh-1", payload: { a: 1 } });
    const e2 = await events.writeEvent(db, { kind: "issue.opened", actor: "human:kyle", project: "mem", summary: "Open #1 again", issue: 1, dedupe_key: "gh-1" });
    expect(e1?.id).toBeTypeOf("number");
    expect(e1?.payload).toEqual({ a: 1 });
    expect(e2).toBeUndefined();

    await events.writeEvent(db, { kind: "step.usage", actor: "agent:anthropic", project: "mem", lane: "plan", model: "anthropic/claude-fable-5-1", subscription: "max", tokens_in: 1000, tokens_out: 100, cache_read: 9000, cost_equiv: 0.5, duration_ms: 10, summary: "plan" });
    await events.writeEvent(db, { kind: "step.usage", actor: "agent:anthropic", project: "mem", lane: "review", model: "anthropic/claude-opus-5", subscription: "max", tokens_in: 3000, tokens_out: 300, cache_read: 7000, cost_equiv: 0.25, duration_ms: 10, summary: "review" });
    await events.writeEvent(db, { kind: "step.usage", actor: "agent:xai", project: "mem", lane: "code", model: "xai/grok-4.7", subscription: "grok", tokens_in: 500, tokens_out: 50, cost_equiv: 0.01, duration_ms: 10, summary: "code" });
    await events.writeEvent(db, { kind: "step.usage", actor: "agent:xai", subscription: "grok", tokens_in: 1, tokens_out: 1, summary: "ancient", ts: "2001-01-01T00:00:00Z" });

    const list = await events.listEvents(db, { project: "mem", kind: "step.", since: "2020-01-01T00:00:00Z" });
    expect(list.length).toBe(3);
    expect(list[0]?.kind).toBe("step.usage");
    expect((await events.listEvents(db, { actor: "human:kyle" })).length).toBe(1);
    expect((await events.listEvents(db, { kind: "issue.opened", limit: 1 })).length).toBe(1);

    const s = await events.usageSummary(db, "2020-01-01T00:00:00Z");
    const max = s.find((r) => r.subscription === "max");
    expect(max?.calls).toBe(2);
    expect(max?.tokens_in).toBe(4000);
    expect(max?.tokens_out).toBe(400);
    expect(max?.cache_read).toBe(16000);
    expect(max?.cost_equiv).toBeCloseTo(0.75);
    expect(max?.avg_ctx).toBe(10000);
    expect(s.find((r) => r.subscription === "grok")?.calls).toBe(1); // the 2001 row is outside the window
  });
});
