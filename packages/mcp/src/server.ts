/**
 * The relay MCP server: one tool set for every transport. Memory tools over the shared Postgres memory, public read
 * tools over the feed and projects, and asset tools over the asset library. One factory serves stdio and HTTP; the
 * granted scopes decide what runs (stdio: everything; HTTP: the bearer token's scopes, plus the read scopes when the
 * deployment allows public read). Every result is plain text capped at RESULT_TOKENS so a tool call can never blow
 * up a session's context.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  approxTokens,
  compileBrief,
  EXTERNAL_KIND,
  finalizeFromKey,
  invalidateBriefCache,
  isTaskState,
  matchingDecisions,
  mergedPreferences,
  openTask,
  renderDecision,
  renderPreference,
  repo,
  safeFilename,
  sniffMime,
  TASK_LANES,
  TASK_PRIORITIES,
  TASK_STATES,
  TaskCreateError,
  TOKEN_SCOPES,
  ulid,
  uploadKeyFor,
  type AssetRow,
  type AssetStore,
  type CompileBriefOptions,
  type Db,
  type GitHubClient,
  type TokenScope,
} from "@relay/core";

export const RESULT_TOKENS = 3000;
export const BRIEF_TOKENS = 2500;
export const SERVER_VERSION = "0.0.1";

export const ALL_SCOPES: TokenScope[] = [...TOKEN_SCOPES];
/** What an unauthenticated caller gets when the deployment allows public read. */
export const PUBLIC_READ_SCOPES: TokenScope[] = ["feed:read", "memory:read"];

/** Tool names with the scope each needs (null = always public). The web app's server card is built from this. */
export const TOOL_SCOPES: Array<{ name: string; scope: TokenScope | null; description: string }> = [
  { name: "relay_get_info", scope: null, description: "Describe this relay deployment: name, version, data mode, projects and links. Public." },
  { name: "relay_get_methodology", scope: null, description: "The five rules and a task's life, as plain text, for briefing another agent. Public." },
  { name: "relay_get_feed", scope: "feed:read", description: "Events newest first with optional project, kind, actor, lane, limit, before, after. Payload and dedupe keys omitted." },
  { name: "relay_get_project", scope: "feed:read", description: "One project by slug with current decisions, models and recent events." },
  { name: "relay_recall", scope: "memory:read", description: "Current decisions and preferences relevant to a query. Call before choosing an approach." },
  { name: "relay_brief", scope: "memory:read", description: "The compiled brief for a project and intent: summary, preferences, decisions, guidance." },
  { name: "relay_guidance", scope: "memory:read", description: "Official vendor guidance chunks for a model, matched to a query." },
  { name: "relay_feed", scope: "memory:read", description: "Recent feed events as compact lines, newest first." },
  { name: "relay_project", scope: "memory:read", description: "A project's record: repo, path, stack, check command, summary and memory counts." },
  { name: "relay_decide", scope: "memory:write", description: "Record a durable decision for a project; supersede an old one by id." },
  { name: "relay_prefer", scope: "memory:write", description: "Set a preference (key = value) at a scope: global, project, lane or model." },
  { name: "relay_asset_list", scope: "assets:read", description: "Assets in the library, pending first; filter by project, status, kind, issue or pr." },
  { name: "relay_asset_get", scope: "assets:read", description: "One asset with its version chain and short-lived signed view URLs." },
  { name: "relay_asset_request_upload", scope: "assets:write", description: "Reserve an asset id and get a one-time upload URL; PUT the bytes there, then call relay_asset_finalize." },
  { name: "relay_asset_finalize", scope: "assets:write", description: "Turn an uploaded object into an asset row (probe, thumbnail, record) after relay_asset_request_upload." },
  { name: "relay_task_create", scope: "tasks:write", description: "Open a task: a GitHub issue in the project's repo with the agent:<lane> label (and priority:<p>); returns task_id and issue_url. Idempotent on idempotency_key." },
  { name: "relay_task_get", scope: "tasks:read", description: "One task by id (owner/repo#n) with its derived state: queued, running, review, done or failed, plus runner, PR and last summary." },
  { name: "relay_task_list", scope: "tasks:read", description: "Tasks with derived state, newest first; filter by project and state." },
  { name: "relay_event_log", scope: "events:write", description: "Log an external.* event in the feed (a bot's own note). The actor is always bot:<token name>; the client cannot choose it." },
  { name: "relay_whoami", scope: null, description: "Who this connection is: token name, granted scopes, expiry and how it authenticated. Public; anonymous callers learn how to get access." },
  { name: "relay_webhook_subscribe", scope: "webhooks:write", description: "Register an outbound webhook for event kinds (exact, a prefix ending in '.', or '*'), optionally one project and a bearer for deliveries. The signing secret is returned once." },
  { name: "relay_webhook_unsubscribe", scope: "webhooks:write", description: "Remove an outbound webhook by id." },
];

/** Description lookup by tool name, so new tools do not depend on their position in TOOL_SCOPES. */
export const toolDescription = (name: string): string => TOOL_SCOPES.find((t) => t.name === name)?.description ?? name;

/** The web app can swap in its richer documents and sanitised feed shapes; without these the server answers from the database. */
export interface SiteHooks {
  info?: () => unknown;
  methodology?: () => string;
  feed?: (opts: { project?: string; kind?: string; actor?: string; lane?: string; limit: number; before?: string; after?: string }) => Promise<unknown>;
  project?: (slug: string) => Promise<unknown | null>;
}

export interface AssetHooks {
  store: AssetStore;
  /** Map a store URL (file:// locally, presigned https for Blob) to what the caller can fetch; identity by default. */
  viewUrl?: (signedUrl: string, key: string) => string;
  uploadUrl?: (signedUrl: string, key: string) => string;
  /** Lifetime of signed URLs in seconds (default 3600). */
  ttl?: number;
}

export interface RelayServerOptions {
  /** True grants every scope (stdio runs as the machine's own user). False means the read scopes only, unless `scopes` says otherwise. */
  canWrite: boolean;
  /** Explicit grants for this connection (HTTP: the bearer token's scopes). */
  scopes?: TokenScope[];
  /** Grant the public read scopes on top of `scopes` (deployment allows unauthenticated reads). */
  publicRead?: boolean;
  /** Who writes are attributed to in the feed, e.g. `human:kyle` or `agent:claude`. */
  actor?: string;
  /** Optional embedder for vector retrieval (set when AI_GATEWAY_API_KEY is configured). */
  embed?: CompileBriefOptions["embed"];
  /** Invalidate the hook brief cache after writes (default true; off in tests). */
  invalidateCache?: boolean;
  site?: SiteHooks;
  assets?: AssetHooks;
  /** GitHub access for relay_task_create (env token on the web, the gh login locally). Without it the tool answers with an error. */
  github?: GitHubClient;
  /** Called with every feed row a tool writes, after the write (the web app fans out webhooks from here). */
  afterEvent?: (row: repo.EventRow) => void | Promise<void>;
  /** What relay_whoami reports about this connection's credential (HTTP: from the token row). */
  identity?: ConnectionIdentity;
  /** Where an anonymous caller can get access (the site's OAuth metadata); shown by relay_whoami and in scope errors. */
  authorizationServer?: string;
  /** One paragraph on how to get access, appended to every scope refusal an anonymous caller gets. */
  accessHint?: string;
}

export interface ConnectionIdentity {
  /** The token's name (`oauth:<client>`, `ci-runner`), or the local user. */
  name: string;
  expires_at: string | null;
  /** db | env | shared | session | local | anonymous */
  source: string;
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
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

const SCOPES = ["global", "project", "lane", "model"] as const;

/** Writes made by an external client are attributed to the token (`bot:<token name>`), never to a name it picks. */
export function externalActor(actor: string): string {
  if (actor.startsWith("human:")) return actor;
  const i = actor.indexOf(":");
  return `bot:${i < 0 ? actor : actor.slice(i + 1)}`;
}
const ASSET_STATUS = ["pending", "approved", "rejected", "superseded", "published"] as const;
const ASSET_KIND = ["image", "video", "audio", "pdf", "html", "file"] as const;

export const METHODOLOGY = `relay: the five rules

1. Tasks move, credentials never do. Every model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI.
2. GitHub is the task bus. An issue is a task, a label picks the lane, a pull request is the result. Nothing of record lives anywhere else.
3. Every step starts fresh with a small brief. No transcript is ever sent to a model. A brief is the repo's rules file, the issue, relevant decisions, and the vendor guidance that matches the intent.
4. Official vendor sources only. Model guidance comes from the vendor's documentation and the skills the vendor publishes.
5. Everything is an event. One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

A task's life: open an issue and add a lane label (GitHub); a runner with that label claims it (your machine); the vendor CLI runs headless under the machine's own login (your machine); a branch and a PR appear with the usage line as a comment (GitHub); the preview builds and a second model reviews (Vercel, your machine); you merge and memory updates (Postgres). Every step above is a row in the feed.`;

/** Scopes a connection holds given the options. */
export function grantedScopes(opts: Pick<RelayServerOptions, "canWrite" | "scopes" | "publicRead">): Set<TokenScope> {
  if (opts.canWrite) return new Set(ALL_SCOPES);
  // No explicit grants = a read-only connection (the stdio server's historical shape).
  const out = new Set<TokenScope>(opts.scopes ?? PUBLIC_READ_SCOPES);
  if (opts.publicRead) for (const s of PUBLIC_READ_SCOPES) out.add(s);
  return out;
}

const publicEvent = (e: repo.EventRow) => {
  const { payload: _p, dedupe_key: _d, ...rest } = e;
  return rest;
};

const publicAsset = (a: AssetRow) => {
  const { storage_key: _s, thumb_key: _t, ...rest } = a;
  return rest;
};

export function createRelayServer(db: Db, opts: RelayServerOptions): McpServer {
  const server = new McpServer({ name: "relay", version: SERVER_VERSION });
  const actor = opts.actor ?? "agent:mcp";
  const embed = opts.embed;
  const granted = grantedScopes(opts);
  const afterWrite = (project?: string | null) => {
    if (opts.invalidateCache === false) return;
    try {
      invalidateBriefCache(project ?? undefined);
    } catch {
      /* cache is best effort */
    }
  };
  const emit = async (row: repo.EventRow | undefined) => {
    if (!row || !opts.afterEvent) return;
    try {
      await opts.afterEvent(row);
    } catch {
      /* delivery problems are the dispatcher's to record */
    }
  };
  const anonymous = !opts.canWrite && !opts.scopes?.length;
  const hint = anonymous && (opts.accessHint || opts.authorizationServer) ? ` ${opts.accessHint ?? `Get one through the authorization server: ${opts.authorizationServer}`}` : "";
  const gate = (scope: TokenScope, tool: string) =>
    granted.has(scope)
      ? undefined
      : fail(
          scope === "memory:write" && !opts.scopes
            ? `relay: writes need a bearer token with memory:write; this connection is read-only`
            : `relay: ${tool} needs a bearer token with the ${scope} scope.${hint}`,
        );
  const assetsHooks = opts.assets;
  const viewUrl = async (key: string | null): Promise<string | null> => {
    if (!key || !assetsHooks) return null;
    const u = await assetsHooks.store.getSignedUrl(key, assetsHooks.ttl ?? 3600);
    return assetsHooks.viewUrl ? assetsHooks.viewUrl(u, key) : u;
  };

  // ---------- public read ----------

  server.registerTool(
    "relay_get_info",
    { title: "Describe relay", description: TOOL_SCOPES[0]!.description, inputSchema: {} },
    async () => {
      if (opts.site?.info) return json(opts.site.info());
      const projects = await repo.listProjects(db);
      return json({
        name: "relay",
        version: SERVER_VERSION,
        data_mode: "db",
        driver: db.driver,
        projects: projects.map((p) => ({ slug: p.slug, repo: p.repo })),
        tools: TOOL_SCOPES.map((t) => ({ name: t.name, scope: t.scope })),
        granted_scopes: [...granted],
      });
    },
  );

  server.registerTool("relay_get_methodology", { title: "How relay works", description: TOOL_SCOPES[1]!.description, inputSchema: {} }, async () => text(opts.site?.methodology ? opts.site.methodology() : METHODOLOGY));

  server.registerTool(
    "relay_get_feed",
    {
      title: "Read the feed",
      description: TOOL_SCOPES[2]!.description,
      inputSchema: {
        project: z.string().optional(),
        kind: z.string().optional(),
        actor: z.string().optional(),
        lane: z.enum(["claude", "codex", "grok"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        after: z.string().datetime({ offset: true }).optional(),
      },
    },
    async (args) => {
      const g = gate("feed:read", "relay_get_feed");
      if (g) return g;
      const limit = args.limit ?? 50;
      if (opts.site?.feed) return json(await opts.site.feed({ ...args, limit }));
      const rows = await repo.listEvents(db, { ...args, limit });
      return json({ events: rows.map(publicEvent), count: rows.length });
    },
  );

  server.registerTool(
    "relay_get_project",
    { title: "Read a project", description: TOOL_SCOPES[3]!.description, inputSchema: { slug: z.string().min(1) } },
    async ({ slug }) => {
      const g = gate("feed:read", "relay_get_project");
      if (g) return g;
      if (opts.site?.project) {
        const p = await opts.site.project(slug);
        return p ? json(p) : fail(`No project with slug '${slug}'.`);
      }
      const p = await repo.getProject(db, slug);
      if (!p) return fail(`No project with slug '${slug}'.`);
      const [decisions, events] = await Promise.all([repo.listDecisions(db, slug, { current: true, limit: 100 }), repo.listEvents(db, { project: slug, limit: 30 })]);
      return json({ ...p, decisions, events: events.map(publicEvent) });
    },
  );

  // ---------- memory ----------

  server.registerTool(
    "relay_recall",
    {
      description: TOOL_SCOPES[4]!.description,
      inputSchema: { query: z.string().describe("what you are about to do"), project: z.string().optional().describe("project slug; omit for global only") },
    },
    async ({ query, project }) => {
      const g = gate("memory:read", "relay_recall");
      if (g) return g;
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
      description: TOOL_SCOPES[9]!.description,
      inputSchema: {
        text: z.string().min(8),
        project: z.string().describe("project slug"),
        source: z.string().optional().describe("claude | codex | grok | human (default from the connection)"),
        supersedes_id: z.number().int().optional(),
      },
    },
    async ({ text: t, project, source, supersedes_id }) => {
      const g = gate("memory:write", "relay_decide");
      if (g) return g;
      if (!(await repo.getProject(db, project))) return fail(`unknown project '${project}'; run relay link in that repo first`);
      const src = source ?? actor.replace(/^(agent|human):/, "");
      const row = supersedes_id ? await repo.supersedeDecision(db, supersedes_id, { text: t, source: src }) : await repo.addDecision(db, { project, text: t, source: src });
      await emit(await repo.writeEvent(db, { kind: "decision.captured", actor, project, summary: t.slice(0, 200), payload: { decision_id: row.id, source: src, superseded: supersedes_id ?? null } }));
      afterWrite(project);
      return text(`recorded decision #${row.id}${supersedes_id ? ` (supersedes #${supersedes_id})` : ""}`);
    },
  );

  server.registerTool(
    "relay_prefer",
    {
      description: TOOL_SCOPES[10]!.description,
      inputSchema: {
        key: z.string().min(1),
        value: z.string(),
        scope: z.enum(SCOPES),
        scope_id: z.string().optional().describe("project slug, lane name or model id; omit for global"),
        reason: z.string().optional(),
      },
    },
    async ({ key, value, scope, scope_id, reason }) => {
      const g = gate("memory:write", "relay_prefer");
      if (g) return g;
      if (scope !== "global" && !scope_id) return fail(`scope '${scope}' needs scope_id`);
      await repo.upsertPreference(db, { key, value, scope, scope_id: scope === "global" ? null : scope_id!, reason: reason ?? null });
      await emit(await repo.writeEvent(db, { kind: "preference.set", actor, project: scope === "project" ? scope_id! : null, summary: `${key} = ${value} (${scope}${scope_id ? `: ${scope_id}` : ""})`, payload: { key, value, scope, scope_id: scope_id ?? null } }));
      afterWrite(scope === "project" ? scope_id : undefined);
      return text(`set ${key} = ${value} at ${scope}${scope_id ? ` ${scope_id}` : ""}`);
    },
  );

  server.registerTool(
    "relay_guidance",
    {
      description: TOOL_SCOPES[6]!.description,
      inputSchema: { model: z.string().describe("model id, e.g. bytedance/seedance-2.5"), query: z.string(), k: z.number().int().min(1).max(12).optional() },
    },
    async ({ model, query, k }) => {
      const g = gate("memory:read", "relay_guidance");
      if (g) return g;
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
      description: TOOL_SCOPES[5]!.description,
      inputSchema: { project: z.string(), intent: z.string(), model: z.string().optional(), max_tokens: z.number().int().min(200).max(RESULT_TOKENS).optional() },
    },
    async ({ project, intent, model, max_tokens }) => {
      const g = gate("memory:read", "relay_brief");
      if (g) return g;
      if (!(await repo.getProject(db, project))) return fail(`unknown project '${project}'`);
      const b = await compileBrief(db, { project, intent, maxTokens: max_tokens ?? BRIEF_TOKENS, ...(model ? { model } : {}), ...(embed ? { embed } : {}) });
      return text(b.text || "Memory is empty for this project.");
    },
  );

  server.registerTool(
    "relay_feed",
    {
      description: TOOL_SCOPES[7]!.description,
      inputSchema: { project: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), kind: z.string().optional().describe("exact kind or a prefix ending in '.'") },
    },
    async ({ project, limit, kind }) => {
      const g = gate("memory:read", "relay_feed");
      if (g) return g;
      const rows = await repo.listEvents(db, { ...(project ? { project } : {}), ...(kind ? { kind } : {}), limit: limit ?? 25 });
      if (!rows.length) return text("No events.");
      return text(rows.map((e) => `${e.ts.slice(0, 16)} ${e.kind} ${e.actor}${e.project ? ` ${e.project}` : ""}: ${e.summary}`).join("\n"));
    },
  );

  server.registerTool("relay_project", { description: TOOL_SCOPES[8]!.description, inputSchema: { slug: z.string() } }, async ({ slug }) => {
    const g = gate("memory:read", "relay_project");
    if (g) return g;
    const p = await repo.getProject(db, slug);
    if (!p) {
      const all = await repo.listProjects(db);
      return fail(`unknown project '${slug}'. Known: ${all.map((x) => x.slug).join(", ") || "(none)"}`);
    }
    const decisions = await repo.listDecisions(db, slug, { current: true, limit: 500 });
    const prefs = await repo.listPreferences(db, "project", slug);
    const head = [`slug: ${p.slug}`, `repo: ${p.repo ?? "-"}`, `path: ${p.path ?? "-"}`, `stack: ${p.stack ?? "-"}`, `check: ${p.check_cmd ?? "-"}`, `decisions: ${decisions.length} current`, `preferences: ${prefs.length} at project scope`, `summary: ${p.summary_tokens ?? 0} tokens`].join("\n");
    return text(p.summary ? `${head}\n\n${p.summary}` : head);
  });

  // ---------- assets ----------

  const noStore = () => fail("relay: this server has no asset store configured");

  server.registerTool(
    "relay_asset_list",
    {
      description: TOOL_SCOPES[11]!.description,
      inputSchema: {
        project: z.string().optional(),
        status: z.enum(ASSET_STATUS).optional(),
        kind: z.enum(ASSET_KIND).optional(),
        issue: z.number().int().optional(),
        pr: z.number().int().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      const g = gate("assets:read", "relay_asset_list");
      if (g) return g;
      const rows = await repo.listAssets(db, { ...args, limit: args.limit ?? 50 });
      return json({ assets: rows.map(publicAsset), count: rows.length });
    },
  );

  server.registerTool(
    "relay_asset_get",
    { description: TOOL_SCOPES[12]!.description, inputSchema: { id: z.string().min(1) } },
    async ({ id }) => {
      const g = gate("assets:read", "relay_asset_get");
      if (g) return g;
      const a = await repo.getAsset(db, id);
      if (!a) return fail(`asset ${id} not found`);
      const versions = await repo.listVersions(db, id);
      const [url, thumb_url] = await Promise.all([viewUrl(a.storage_key), viewUrl(a.thumb_key)]);
      return json({ ...publicAsset(a), url, thumb_url, versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, created_at: v.created_at })) });
    },
  );

  server.registerTool(
    "relay_asset_request_upload",
    {
      description: TOOL_SCOPES[13]!.description,
      inputSchema: {
        project: z.string().min(1),
        filename: z.string().min(1),
        content_type: z.string().optional().describe("sniffed from the filename when omitted"),
        ttl: z.number().int().min(60).max(86_400).optional().describe("seconds the upload URL stays valid (default 900)"),
      },
    },
    async ({ project, filename, content_type, ttl }) => {
      const g = gate("assets:write", "relay_asset_request_upload");
      if (g) return g;
      if (!assetsHooks) return noStore();
      if (!(await repo.getProject(db, project))) return fail(`unknown project '${project}'`);
      const id = ulid();
      const key = uploadKeyFor(project, id, filename);
      const contentType = content_type ?? sniffMime(Buffer.alloc(0), safeFilename(filename));
      const seconds = ttl ?? 900;
      const raw = await assetsHooks.store.getUploadUrl(key, seconds, { contentType });
      const upload_url = assetsHooks.uploadUrl ? assetsHooks.uploadUrl(raw, key) : raw;
      return json({
        id,
        key,
        upload_url,
        method: "PUT",
        headers: { "content-type": contentType },
        expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
        then: { tool: "relay_asset_finalize", arguments: { key, project } },
      });
    },
  );

  server.registerTool(
    "relay_asset_finalize",
    {
      description: TOOL_SCOPES[14]!.description,
      inputSchema: {
        key: z.string().min(1).describe("the key relay_asset_request_upload returned"),
        project: z.string().min(1),
        issue: z.number().int().optional(),
        pr: z.number().int().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        replaces: z.string().optional().describe("asset id this upload supersedes"),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ key, project, issue, pr, title, description, replaces, tags }) => {
      const g = gate("assets:write", "relay_asset_finalize");
      if (g) return g;
      if (!assetsHooks) return noStore();
      try {
        const row = await finalizeFromKey(db, assetsHooks.store, { key, project, issue, pr, title, description, replaces: replaces ?? null, tags, createdBy: actor });
        return json({ ...publicAsset(row), url: await viewUrl(row.storage_key) });
      } catch (e) {
        return fail(`relay: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ---------- tasks and external events (docs/INTEGRATIONS.md) ----------

  server.registerTool(
    "relay_task_create",
    {
      title: "Open a task",
      description: toolDescription("relay_task_create"),
      inputSchema: {
        project: z.string().min(1).describe("project slug (relay link registered it)"),
        title: z.string().min(1).max(256),
        body: z.string().max(60_000).optional().describe("issue body, markdown; the brief the lane reads"),
        lane: z.enum(TASK_LANES).describe("which subscription implements it"),
        priority: z.enum(TASK_PRIORITIES).optional(),
        idempotency_key: z.string().min(1).max(200).optional().describe("repeat calls with the same key return the same task and open nothing"),
      },
    },
    async (args) => {
      const g = gate("tasks:write", "relay_task_create");
      if (g) return g;
      try {
        const r = await openTask(db, opts.github, { ...args, actor: externalActor(actor) });
        for (const e of r.events) await emit(e);
        return json({ task_id: r.task_id, issue_url: r.issue_url, created: r.created, state: r.task.state, lane: args.lane });
      } catch (e) {
        return fail(`relay: ${e instanceof Error ? e.message : String(e)}${e instanceof TaskCreateError && e.status === 503 ? " (relay_task_create needs GitHub access on the server)" : ""}`);
      }
    },
  );

  server.registerTool(
    "relay_task_get",
    { title: "Read a task", description: toolDescription("relay_task_get"), inputSchema: { task_id: z.string().min(3).describe("owner/repo#n") } },
    async ({ task_id }) => {
      const g = gate("tasks:read", "relay_task_get");
      if (g) return g;
      const t = await repo.getTask(db, task_id.trim());
      if (!t) return fail(`relay: no task ${task_id}`);
      return json(await repo.taskView(db, t));
    },
  );

  server.registerTool(
    "relay_task_list",
    {
      title: "List tasks",
      description: toolDescription("relay_task_list"),
      inputSchema: { project: z.string().optional(), state: z.enum(TASK_STATES as unknown as [string, ...string[]]).optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ project, state, limit }) => {
      const g = gate("tasks:read", "relay_task_list");
      if (g) return g;
      const rows = await repo.listTaskViews(db, { ...(project ? { project } : {}), ...(state && isTaskState(state) ? { state } : {}), limit: limit ?? 50 });
      return json({ tasks: rows, count: rows.length });
    },
  );

  server.registerTool("relay_whoami", { title: "Who am I", description: toolDescription("relay_whoami"), inputSchema: {} }, async () => {
    const identity = opts.identity ?? (opts.canWrite ? { name: actor, expires_at: null, source: "local" } : { name: "anonymous", expires_at: null, source: "anonymous" });
    return json({
      actor: anonymous ? "anon" : actor,
      name: identity.name,
      scopes: [...granted],
      expires_at: identity.expires_at,
      source: identity.source,
      authenticated: !anonymous,
      ...(anonymous && opts.authorizationServer ? { how_to_authenticate: `OAuth 2.1 with PKCE, the device flow, or an invite code: ${opts.authorizationServer}` } : {}),
    });
  });

  server.registerTool(
    "relay_webhook_subscribe",
    {
      title: "Subscribe a webhook",
      description: toolDescription("relay_webhook_subscribe"),
      inputSchema: {
        url: z.string().url().describe("where relay POSTs deliveries"),
        events: z.array(z.string().min(1)).min(1).describe("kinds such as pr.merged, run.failed; a prefix like 'run.'; or '*'"),
        bearer: z.string().min(1).max(500).optional().describe("sent as Authorization: Bearer on every delivery, e.g. the bot's routine key"),
        project: z.string().optional().describe("limit to one project slug"),
      },
    },
    async ({ url, events, bearer, project }) => {
      const g = gate("webhooks:write", "relay_webhook_subscribe");
      if (g) return g;
      const badUrl = repo.validateWebhookUrl(url);
      if (badUrl) return fail(`relay: ${badUrl}`);
      if (project && !(await repo.getProject(db, project))) return fail(`relay: unknown project '${project}'`);
      try {
        const row = await repo.createWebhook(db, { project: project ?? null, url, events, bearer: bearer ?? null, createdBy: externalActor(actor) });
        return json({ webhook: repo.publicWebhook(row), secret: row.secret, note: "The secret is shown once; verify X-Relay-Signature with it (docs/FEED.md)." });
      } catch (e) {
        return fail(`relay: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool("relay_webhook_unsubscribe", { title: "Unsubscribe a webhook", description: toolDescription("relay_webhook_unsubscribe"), inputSchema: { id: z.string().min(1) } }, async ({ id }) => {
    const g = gate("webhooks:write", "relay_webhook_unsubscribe");
    if (g) return g;
    const removed = await repo.deleteWebhook(db, id);
    return removed ? json({ removed: id }) : fail(`relay: no webhook ${id}`);
  });

  server.registerTool(
    "relay_event_log",
    {
      title: "Log an external event",
      description: toolDescription("relay_event_log"),
      inputSchema: {
        kind: z.string().regex(EXTERNAL_KIND, "kind must start with 'external.'").describe("external.<something>, e.g. external.briefing"),
        project: z.string().optional(),
        summary: z.string().min(1).max(500),
        url: z.string().url().optional(),
        cost_equiv: z.number().min(0).optional().describe("USD equivalent the external step cost, if any"),
        source: z.string().max(100).optional().describe("the external system, e.g. grok-bot; kept in payload"),
      },
    },
    async ({ kind, project, summary, url, cost_equiv, source }) => {
      const g = gate("events:write", "relay_event_log");
      if (g) return g;
      if (project && !(await repo.getProject(db, project))) return fail(`relay: unknown project '${project}'`);
      const row = await repo.writeEvent(db, { kind, actor: externalActor(actor), project: project ?? null, summary, url: url ?? null, cost_equiv: cost_equiv ?? 0, payload: source ? { source } : {} });
      await emit(row);
      return json(row ? { id: row.id, ts: row.ts, kind: row.kind, actor: row.actor } : { deduped: true });
    },
  );

  return server;
}
