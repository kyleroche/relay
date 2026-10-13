/**
 * The relay memory server: seven small tools over the shared Postgres memory. One factory serves both transports;
 * `canWrite` decides whether relay_decide / relay_prefer are allowed (stdio: always; HTTP: bearer token).
 * Every result is plain text capped at RESULT_TOKENS so a tool call can never blow up a session's context.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { approxTokens, compileBrief, invalidateBriefCache, matchingDecisions, mergedPreferences, renderDecision, renderPreference, repo, type CompileBriefOptions, type Db } from "@relay/core";

export const RESULT_TOKENS = 3000;
export const BRIEF_TOKENS = 2500;

export interface RelayServerOptions {
  /** Whether write tools (relay_decide, relay_prefer) may run. */
  canWrite: boolean;
  /** Who writes are attributed to in the feed, e.g. `human:kyle` or `agent:claude`. */
  actor?: string;
  /** Optional embedder for vector retrieval (set when AI_GATEWAY_API_KEY is configured). */
  embed?: CompileBriefOptions["embed"];
  /** Invalidate the hook brief cache after writes (default true; off in tests). */
  invalidateCache?: boolean;
}

/** Cut text at a line boundary so it stays under `max` approximate tokens; says so when it did. */
export function capText(text: string, max = RESULT_TOKENS): string {
  if (approxTokens(text) <= max) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const t = approxTokens(l + "\n");
    if (used + t > max - 12) break;
    out.push(l);
    used += t;
  }
  return out.join("\n") + `\n…(truncated at ${max} tokens)`;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: capText(s) }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

const SCOPES = ["global", "project", "lane", "model"] as const;

export function createRelayServer(db: Db, opts: RelayServerOptions): McpServer {
  const server = new McpServer({ name: "relay", version: "0.0.1" });
  const actor = opts.actor ?? "agent:mcp";
  const embed = opts.embed;
  const afterWrite = (project?: string | null) => {
    if (opts.invalidateCache === false) return;
    try {
      invalidateBriefCache(project ?? undefined);
    } catch {
      /* cache is best effort */
    }
  };
  const writeGate = () => (opts.canWrite ? undefined : fail("relay: writes need a bearer token (RELAY_MEMORY_TOKEN); this connection is read-only"));

  server.registerTool(
    "relay_recall",
    {
      description: "Current decisions and preferences relevant to a query. Call before choosing an approach.",
      inputSchema: { query: z.string().describe("what you are about to do"), project: z.string().optional().describe("project slug; omit for global only") },
    },
    async ({ query, project }) => {
      const parts: string[] = [];
      if (project) {
        const prefs = await mergedPreferences(db, { project });
        if (prefs.length) parts.push("Preferences:\n" + prefs.map(renderPreference).join("\n"));
        const ds = await matchingDecisions(db, project, query, { ...(embed ? { embed } : {}) });
        if (ds.length) parts.push("Decisions:\n" + ds.map(renderDecision).join("\n"));
      } else {
        const prefs = await repo.listPreferences(db, "global");
        if (prefs.length) parts.push("Preferences:\n" + prefs.map(renderPreference).join("\n"));
        const ds = query.trim() ? await repo.searchDecisions(db, undefined, query, 12) : await repo.listDecisions(db, undefined, { current: true, limit: 12 });
        if (ds.length) parts.push("Decisions:\n" + ds.map((d) => renderDecision(d) + (d.project ? ` (${d.project})` : "")).join("\n"));
      }
      return text(parts.length ? parts.join("\n\n") : "No matching decisions or preferences.");
    },
  );

  server.registerTool(
    "relay_decide",
    {
      description: "Record a durable decision: one sentence, 'we do X because Y'. Supersede an old one by id.",
      inputSchema: {
        text: z.string().min(8),
        project: z.string().describe("project slug"),
        source: z.string().optional().describe("claude | codex | grok | human (default from the connection)"),
        supersedes_id: z.number().int().optional(),
      },
    },
    async ({ text: t, project, source, supersedes_id }) => {
      const gate = writeGate();
      if (gate) return gate;
      if (!(await repo.getProject(db, project))) return fail(`unknown project '${project}'; run relay link in that repo first`);
      const src = source ?? actor.replace(/^(agent|human):/, "");
      const row = supersedes_id ? await repo.supersedeDecision(db, supersedes_id, { text: t, source: src }) : await repo.addDecision(db, { project, text: t, source: src });
      await repo.writeEvent(db, { kind: "decision.captured", actor, project, summary: t.slice(0, 200), payload: { decision_id: row.id, source: src, superseded: supersedes_id ?? null } });
      afterWrite(project);
      return text(`recorded decision #${row.id}${supersedes_id ? ` (supersedes #${supersedes_id})` : ""}`);
    },
  );

  server.registerTool(
    "relay_prefer",
    {
      description: "Set a preference (key = value) at a scope: global, project, lane or model.",
      inputSchema: {
        key: z.string().min(1),
        value: z.string(),
        scope: z.enum(SCOPES),
        scope_id: z.string().optional().describe("project slug, lane name or model id; omit for global"),
        reason: z.string().optional(),
      },
    },
    async ({ key, value, scope, scope_id, reason }) => {
      const gate = writeGate();
      if (gate) return gate;
      if (scope !== "global" && !scope_id) return fail(`scope '${scope}' needs scope_id`);
      await repo.upsertPreference(db, { key, value, scope, scope_id: scope === "global" ? null : scope_id!, reason: reason ?? null });
      await repo.writeEvent(db, { kind: "preference.set", actor, project: scope === "project" ? scope_id! : null, summary: `${key} = ${value} (${scope}${scope_id ? `: ${scope_id}` : ""})`, payload: { key, value, scope, scope_id: scope_id ?? null } });
      afterWrite(scope === "project" ? scope_id : undefined);
      return text(`set ${key} = ${value} at ${scope}${scope_id ? ` ${scope_id}` : ""}`);
    },
  );

  server.registerTool(
    "relay_guidance",
    {
      description: "Official vendor guidance chunks for a model, matched to a query.",
      inputSchema: { model: z.string().describe("model id, e.g. bytedance/seedance-2.5"), query: z.string(), k: z.number().int().min(1).max(12).optional() },
    },
    async ({ model, query, k }) => {
      const m = await repo.getModel(db, model);
      if (!m) return fail(`unknown model '${model}'`);
      if (!m.onboarded_at) return fail(`model '${model}' is not onboarded; run: relay onboard ${model}`);
      let hits: repo.GuidanceHit[] = [];
      if (embed) {
        const v = await embed(query).catch(() => null);
        if (v) hits = await repo.vectorSearchGuidance(db, model, v, k ?? 6);
      }
      if (!hits.length) hits = await repo.textSearchGuidance(db, model, query, k ?? 6);
      if (!hits.length) return text("No matching guidance.");
      return text(hits.map((h) => `### ${h.title} (${h.kind})\n${h.text.trim()}\nSource: ${h.source_url}`).join("\n\n"));
    },
  );

  server.registerTool(
    "relay_brief",
    {
      description: "The compiled brief for a project and intent: summary, preferences, decisions, guidance (≤2.5K tokens).",
      inputSchema: { project: z.string(), intent: z.string(), model: z.string().optional(), max_tokens: z.number().int().min(200).max(RESULT_TOKENS).optional() },
    },
    async ({ project, intent, model, max_tokens }) => {
      if (!(await repo.getProject(db, project))) return fail(`unknown project '${project}'`);
      const b = await compileBrief(db, { project, intent, maxTokens: max_tokens ?? BRIEF_TOKENS, ...(model ? { model } : {}), ...(embed ? { embed } : {}) });
      return text(b.text || "Memory is empty for this project.");
    },
  );

  server.registerTool(
    "relay_feed",
    {
      description: "Recent feed events (what agents and humans did), newest first.",
      inputSchema: { project: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), kind: z.string().optional().describe("exact kind or a prefix ending in '.'") },
    },
    async ({ project, limit, kind }) => {
      const rows = await repo.listEvents(db, { ...(project ? { project } : {}), ...(kind ? { kind } : {}), limit: limit ?? 25 });
      if (!rows.length) return text("No events.");
      return text(rows.map((e) => `${e.ts.slice(0, 16)} ${e.kind} ${e.actor}${e.project ? ` ${e.project}` : ""}: ${e.summary}`).join("\n"));
    },
  );

  server.registerTool(
    "relay_project",
    { description: "A project's record: repo, path, stack, check command, summary, and memory counts.", inputSchema: { slug: z.string() } },
    async ({ slug }) => {
      const p = await repo.getProject(db, slug);
      if (!p) {
        const all = await repo.listProjects(db);
        return fail(`unknown project '${slug}'. Known: ${all.map((x) => x.slug).join(", ") || "(none)"}`);
      }
      const decisions = await repo.listDecisions(db, slug, { current: true, limit: 500 });
      const prefs = await repo.listPreferences(db, "project", slug);
      const head = [`slug: ${p.slug}`, `repo: ${p.repo ?? "-"}`, `path: ${p.path ?? "-"}`, `stack: ${p.stack ?? "-"}`, `check: ${p.check_cmd ?? "-"}`, `decisions: ${decisions.length} current`, `preferences: ${prefs.length} at project scope`, `summary: ${p.summary_tokens ?? 0} tokens`].join("\n");
      return text(p.summary ? `${head}\n\n${p.summary}` : head);
    },
  );

  return server;
}
