/**
 * The relay MCP server: one tool set for every transport. Memory tools over the shared Postgres memory, public read
 * tools over the feed and projects, asset tools over the asset library, task and external-event tools for
 * bots, and the access and invite tools (tokens:write) that let one trusted bot approve other agents' device codes
 * and mint invites without anyone opening the Access page. One factory serves stdio and HTTP; the granted scopes
 * decide what runs (stdio: everything; HTTP: the bearer token's scopes, plus the read scopes when the deployment
 * allows public read). Every result is plain text capped at RESULT_TOKENS so a tool call can never blow up a
 * session's context.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  approxTokens,
  board,
  compileBrief,
  createInvite,
  decideDeviceRequest,
  EXTERNAL_KIND,
  finalizeFromKey,
  GRANT_INVITE,
  invalidateBriefCache,
  listRecentAccess,
  matchingDecisions,
  mergedPreferences,
  OAuthError,
  parseDuration,
  renderDecision,
  renderPreference,
  repo,
  revokeInvite,
  safeFilename,
  sniffMime,
  TOKEN_SCOPES,
  ulid,
  uploadKeyFor,
  WORKER_LANES,
  type AccessRequestView,
  type AssetRow,
  type AssetStore,
  type CompileBriefOptions,
  type Db,
  type GitHubClient,
  type OAuthServerOptions,
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
  { name: "relay_asset_review", scope: "assets:review", description: "Approve or reject an asset in the library; a rejection needs a note, which becomes the decision the next attempt reads. A bot may review only with assets:review and never an asset its own runs produced." },
  { name: "relay_task_create", scope: "tasks:write", description: "Open a task: a thread in the project's queue on the team's Vercel Board, labelled with its lane (and model). Returns task_id (the board's message ID) and its state. Refused for a lane that is neither built in nor served by a worker. Idempotent on idempotency_key." },
  { name: "relay_task_get", scope: "tasks:read", description: "One task by ID with its state: waiting (a task it needs has not completed), queued, running, review (a pull request or outputs wait for a decision), held (the injection gate flagged the text), blocked (held for another reason, such as an eval looking at it), done, failed or closed. Plus the lane, model, pull request, the hold and its reason, who holds the claim, the last result, usage rows and the latest notes in its thread." },
  { name: "relay_task_list", scope: "tasks:read", description: "Tasks on the board, oldest first; filter by project and state. Default state=open (everything not done or closed). state=review is what waits for a decision; state=held is what the injection gate stopped and a person should read." },
  { name: "relay_task_approve", scope: "tasks:write", description: "Approve a task in review: relay squash-merges its pull request through GitHub, deletes the branch and completes the task (or, for a task whose deliverable is its attached outputs, completes it). Only the pull request the runner's hold names is merged, and only when its branch is the task's own. A bot never approves a task it opened. GitHub's refusal comes back as an error and the task stays in review." },
  { name: "relay_task_request_changes", scope: "tasks:write", description: "Send a task in review back with a note: the note goes in the task's thread and as a comment on the pull request, and the task is queued; the next run reads the note and pushes to the same pull request." },
  { name: "relay_task_release", scope: "tokens:write", description: "Release a task the injection gate held (state held) for the text as it stands: the task is queued and the gate does not grade that text again; anything added later is graded. Only for text a person has read and judged safe. A bot needs tokens:write and never releases a task whose text it wrote any part of (the task itself, or a note in its thread)." },
  { name: "relay_task_close", scope: "tasks:write", description: "Close a task without a merge from any state but done or closed: canceled on the board with the reason, which also stops a run in progress; its open pull request and branch and the issue it answers are closed on GitHub (best effort). For a task opened by mistake, against a spec the repo does not match, or a duplicate." },
  { name: "relay_task_requeue", scope: "tasks:write", description: "Put a failed, held or blocked task back in the queue, optionally on another lane or model; the next run starts over from the base branch. A running task is refused with who holds it; relay_task_close stops a run." },
  { name: "relay_event_log", scope: "events:write", description: "Log an external.* event in the feed (a bot's own note). The actor is always bot:<token name>; the client cannot choose it." },
  { name: "relay_whoami", scope: null, description: "Who this connection is: token name, granted scopes, expiry and how it authenticated. Public; anonymous callers learn how to get access." },
  { name: "relay_access_list", scope: "tokens:write", description: "Device requests waiting for a decision (user_code, client_name, scopes, requested and expiry times) and approvals the device has not polled yet. For the bot that approves other agents." },
  { name: "relay_access_approve", scope: "tokens:write", description: "Approve (default) or deny a pending device request by its user code: the same decision the Access page makes. The device receives its token on its next poll; the decision is attributed to this token. A bot can approve only scopes it holds itself, and never tokens:write; wider requests are for a person at /activate." },
  { name: "relay_invite_create", scope: "tokens:write", description: "Mint an invite code for an agent or machine trusted in advance: a name, scopes, optional expiry (24h default) and uses (1 default). The code is returned once; redeeming it needs no approval. A bot can invite only to scopes it holds itself, and never tokens:write." },
  { name: "relay_invite_revoke", scope: "tokens:write", description: "Revoke a live invite by id or name; an unredeemed code stops working at once." },
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
  /** After relay_asset_finalize: the web app comments on the issue. Best effort. */
  afterUpload?: (row: AssetRow) => void | Promise<void>;
  /** After relay_asset_review: the web app comments on the issue and closes it on approval. Best effort. */
  afterReview?: (row: AssetRow) => void | Promise<void>;
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
  /**
   * The board the task tools work on (`relay setup --board` locally, the deployment's own team on a site). `asActor`
   * is true where the handle is not the caller: a site's handle is its deployment, so each write is made as a profile
   * named for whoever asked. Without it the task tools answer with how to get one.
   */
  board?: { open: () => Promise<board.BoardSession>; asActor: boolean };
  /** GitHub access for relay_task_approve, relay_task_request_changes and relay_task_close (the GitHub App or a token on a site, the gh login locally). Without it approve answers with an error, and request-changes and close do their part on the board only. */
  github?: GitHubClient;
  /** What relay_whoami reports about this connection's credential (HTTP: from the token row). */
  identity?: ConnectionIdentity;
  /** Where an anonymous caller can get access (the site's OAuth metadata); shown by relay_whoami and in scope errors. */
  authorizationServer?: string;
  /** One paragraph on how to get access, appended to every scope refusal an anonymous caller gets. */
  accessHint?: string;
  /**
   * The authorization server this database belongs to, for the access and invite tools: `issuer` is the site whose
   * `relay setup --site <issuer> --invite <code>` line relay_invite_create prints (unset locally: the line keeps a
   * placeholder); `now` is the clock (tests).
   */
  oauth?: { issuer?: string; now?: () => number };
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
2. The team's Vercel Board is the task bus. A task is a thread in its project's queue, a label picks the lane, a pull request on GitHub is the result.
3. Every step starts fresh with a small brief. No transcript is ever sent to a model. A brief is the repo's rules file, the issue, relevant decisions, and the vendor guidance that matches the intent.
4. Official vendor sources only. Model guidance comes from the vendor's documentation and the skills the vendor publishes.
5. Everything is an event. One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

A task's life: open a task with a lane (relay_task_create, or relay task create); a worker that serves that lane claims it from the board under a lease (your machine, running \`relay work\`); the vendor CLI runs headless under the machine's own login (your machine); a branch and a PR appear with the usage line as a comment (GitHub); the preview builds and a second model reviews (Vercel, your machine); you merge and memory updates (Postgres). Every step above is a row in the feed.`;

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
  const viewUrl = async (key: string | null, ttl?: number): Promise<string | null> => {
    if (!key || !assetsHooks) return null;
    const u = await assetsHooks.store.getSignedUrl(key, ttl ?? assetsHooks.ttl ?? 3600);
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
        lane: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "a lane name: lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter").optional().describe(`one of ${WORKER_LANES.join(", ")}, or the lane another worker serves`),
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
        source_ref: z.string().max(200).optional().describe("where the decision came from, for whoever recorded it (a file name, a session)"),
      },
    },
    async ({ text: t, project, source, supersedes_id, source_ref }) => {
      const g = gate("memory:write", "relay_decide");
      if (g) return g;
      if (!(await repo.getProject(db, project))) return fail(`unknown project '${project}'; run relay link in that repo first`);
      const src = source ?? actor.replace(/^(agent|human):/, "");
      const ref = source_ref ? { sourceRef: source_ref } : {};
      const row = supersedes_id ? await repo.supersedeDecision(db, supersedes_id, { text: t, source: src, ...ref }) : await repo.addDecision(db, { project, text: t, source: src, ...ref });
      await repo.writeEvent(db, { kind: "decision.captured", actor, project, summary: t.slice(0, 200), payload: { decision_id: row.id, source: src, superseded: supersedes_id ?? null } });
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
      await repo.writeEvent(db, { kind: "preference.set", actor, project: scope === "project" ? scope_id! : null, summary: `${key} = ${value} (${scope}${scope_id ? `: ${scope_id}` : ""})`, payload: { key, value, scope, scope_id: scope_id ?? null } });
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
        const row = await finalizeFromKey(db, assetsHooks.store, { key, project, issue, pr, title, description, replaces: replaces ?? null, tags, createdBy: externalActor(actor) });
        await assetsHooks.afterUpload?.(row);
        return json({ ...publicAsset(row), url: await viewUrl(row.storage_key) });
      } catch (e) {
        return fail(`relay: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "relay_asset_review",
    {
      title: "Approve or reject an asset",
      description: toolDescription("relay_asset_review"),
      inputSchema: {
        id: z.string().min(1).describe("asset id (relay_asset_list, or the asset.uploaded delivery)"),
        decision: z.enum(["approved", "rejected"]),
        note: z.string().max(10_000).optional().describe("required on rejection: what should change, written for the model that will act on it"),
      },
    },
    async ({ id, decision, note }) => {
      const g = gate("assets:review", "relay_asset_review");
      if (g) return g;
      const text = note?.trim() || null;
      if (decision === "rejected" && !text) return fail("relay: a rejection needs a note; it becomes the decision the next attempt reads");
      try {
        const before = await repo.getAsset(db, id);
        if (!before) return fail(`relay: no asset ${id}`);
        if (before.status !== "pending") return fail(`relay: asset ${id} is ${before.status}; only a pending asset can be reviewed`);
        if (before.created_by === externalActor(actor)) return fail(`relay: ${actor} produced this asset and cannot review it; a person or another bot decides`);
        const row = await repo.reviewAsset(db, id, { decision, by: externalActor(actor), note: text });
        await assetsHooks?.afterReview?.(row);
        return json(publicAsset(row));
      } catch (e) {
        return fail(`relay: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ---------- tasks (docs/INTEGRATIONS.md): threads on the team's board, through the same functions the CLI calls ----------

  const LANE = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "a lane name: lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter");
  const TASK_ID = z.string().min(1).describe("the task's ID on the board, as relay_task_create and relay_task_list return it");
  const NO_BOARD = "relay: this server has no board to work on. Locally: vercel login, then relay setup --board. On a site: the deployment must be on the Vercel team that owns the board.";
  /** The desk (board/desk.ts): on a site the caller is someone the site answers for, with the rules that go with it; locally the caller is the handle. */
  const deskNow = async (): Promise<board.Desk> => board.deskFor(await opts.board!.open(), opts.board!.asActor ? { actor: externalActor(actor), scopes: [...granted] } : undefined);
  const taskFail = (e: unknown, tool: string) => fail(`relay: ${board.describeBoardError(e)}${e instanceof board.TaskError && e.status === 503 ? ` (${tool} needs GitHub access on the server)` : ""}`);
  const taskView = (t: board.BoardTask) => ({
    task_id: t.id,
    state: t.state,
    project: t.project ?? null,
    title: t.title,
    lane: t.lane,
    model: t.model,
    repo: t.repo,
    pr_url: t.pr?.url ?? null,
    hold: t.hold,
    needs: t.needs,
    claim: t.claim,
    result: t.result,
    reason: t.reason,
    created_at: t.created_at,
  });
  /** One task tool: the scope gate, the board, and a refusal as one line. */
  const taskTool = async (scope: TokenScope, tool: string, run: (desk: board.Desk) => Promise<ReturnType<typeof json>>) => {
    const g = gate(scope, tool);
    if (g) return g;
    if (!opts.board) return fail(NO_BOARD);
    try {
      return await run(await deskNow());
    } catch (e) {
      return taskFail(e, tool);
    }
  };

  server.registerTool(
    "relay_task_create",
    {
      title: "Open a task",
      description: toolDescription("relay_task_create"),
      inputSchema: {
        project: z.string().min(1).describe("project slug (relay link or relay project add registered it)"),
        title: z.string().min(1).max(200),
        body: z.string().max(60_000).optional().describe("the task's text, markdown: what to do and how to tell it is done"),
        lane: LANE.optional().describe(`who runs it: ${WORKER_LANES.join(", ")} run on the user's own workers; ${board.ANY_LANE} is whichever code lane is free; default claude. Another lane works once a worker serves it; the error names the lanes that have one.`),
        model: z.string().min(1).max(100).optional().describe("the model the lane should use; the lane's default without it"),
        needs: z.array(z.string().min(1)).max(20).optional().describe("task IDs that must complete first; the task waits for them"),
        base: z.string().min(1).max(200).optional().describe("start from this branch instead of the repository's default one"),
        plan: z.boolean().optional().describe("open it as a planning task: a lane reads the repository and proposes tasks, and nothing is opened until the plan is approved, like any task in review. Use it for an ask that needs breaking down."),
        idempotency_key: z.string().min(1).max(200).optional().describe("repeat calls with the same key return the same task and open nothing"),
      },
    },
    (args) =>
      taskTool("tasks:write", "relay_task_create", async (desk) => {
        const project = await repo.getProject(db, args.project);
        if (!project) throw new board.TaskError(`no project '${args.project}'; relay_get_project lists the ones this relay knows`, 404);
        if (!project.repo) throw new board.TaskError(`project '${args.project}' has no repository to work in (relay project add ${args.project} --repo owner/name)`, 400);
        const { task: t, created } = await board.openFor(
          desk,
          {
            project: project.slug,
            repo: project.repo,
            title: args.title,
            body: args.body ?? "",
            lane: args.lane ?? "claude",
            ...(args.model ? { model: args.model } : {}),
            ...(args.needs?.length ? { needs: args.needs } : {}),
            ...(args.base ? { base: args.base } : {}),
            ...(args.plan ? { step: "plan" } : {}),
            ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
          },
          opts.board!.asActor ? { brief: async (task) => (await compileBrief(db, { project: project.slug, intent: "implement the task", maxTokens: BRIEF_TOKENS, shared: true, ...(task.lane ? { lane: task.lane } : {}), issue: { title: task.title, body: task.body } })).text } : {},
        );
        return json({ ...taskView(t), created });
      }),
  );

  server.registerTool("relay_task_get", { title: "Read a task", description: toolDescription("relay_task_get"), inputSchema: { task_id: TASK_ID } }, ({ task_id }) =>
    taskTool("tasks:read", "relay_task_get", async (desk) => {
      const d = await board.getTask(desk.session.board, task_id.trim(), { trusted: desk.session.from });
      const results = d.thread.replies.filter((m) => !m.deleted && m.labels?.relay === board.RELAY_MESSAGE.result);
      return json({ ...taskView(d.task), body: d.task.body, last_result: results.length ? board.withoutBlocks(results.at(-1)!.text) : null, usage: d.usage, notes: d.notes.slice(-10) });
    }),
  );

  server.registerTool(
    "relay_task_list",
    {
      title: "List tasks",
      description: toolDescription("relay_task_list"),
      inputSchema: { project: z.string().optional(), state: z.enum(["open", "all", ...board.RELAY_STATES] as [string, ...string[]]).optional().describe("default open: everything not done or closed"), limit: z.number().int().min(1).max(200).optional() },
    },
    ({ project, state, limit }) =>
      taskTool("tasks:read", "relay_task_list", async (desk) => {
        const rows = await board.listTasks(desk.session.board, { ...(project ? { project } : {}), state: (state ?? "open") as board.RelayState | "open" | "all", limit: limit ?? 50 });
        return json({ tasks: rows.map(taskView), count: rows.length });
      }),
  );

  server.registerTool("relay_task_approve", { title: "Approve and merge a task", description: toolDescription("relay_task_approve"), inputSchema: { id: TASK_ID } }, ({ id }) =>
    taskTool("tasks:write", "relay_task_approve", async (desk) => {
      const r = await board.approveFor(desk, opts.github, id.trim());
      return json({ ...taskView(r.task), pr_url: r.pr_url, merge_sha: r.merge_sha, branch_deleted: r.branch_deleted });
    }),
  );

  server.registerTool(
    "relay_task_request_changes",
    { title: "Request changes on a task", description: toolDescription("relay_task_request_changes"), inputSchema: { id: TASK_ID, note: z.string().min(1).max(6000).describe("what should change; written for the model that will address it") } },
    ({ id, note }) =>
      taskTool("tasks:write", "relay_task_request_changes", async (desk) => {
        const t = await board.requestChangesFor(desk, opts.github, id.trim(), note);
        return json({ ...taskView(t), next: "the next worker that serves the lane runs it again with the note in the thread and pushes to the same pull request" });
      }),
  );

  server.registerTool(
    "relay_task_requeue",
    {
      title: "Requeue a task",
      description: toolDescription("relay_task_requeue"),
      inputSchema: { id: TASK_ID, lane: LANE.optional().describe("move the task to this lane; omitted keeps the lane it has"), model: z.string().min(1).max(100).optional().describe("ask for this model; omitted keeps what it has") },
    },
    ({ id, lane, model }) =>
      taskTool("tasks:write", "relay_task_requeue", async (desk) => {
        const t = await board.requeueFor(desk, id.trim(), { ...(lane ? { lane } : {}), ...(model ? { model } : {}) });
        return json({ ...taskView(t), next: "the next idle worker that serves the lane claims it and starts over from the base branch" });
      }),
  );

  server.registerTool(
    "relay_task_close",
    { title: "Close a task", description: toolDescription("relay_task_close"), inputSchema: { id: TASK_ID, reason: z.string().max(900).optional().describe("why; it is the task's closing reason and a comment on its pull request and issue") } },
    ({ id, reason }) =>
      taskTool("tasks:write", "relay_task_close", async (desk) => {
        const r = await board.closeFor(desk, opts.github, id.trim(), reason);
        return json({ ...taskView(r.task), github: r.github, canceled: r.canceled, to_review: r.to_review });
      }),
  );

  server.registerTool("relay_task_release", { title: "Release a held task", description: toolDescription("relay_task_release"), inputSchema: { id: TASK_ID } }, ({ id }) =>
    taskTool("tokens:write", "relay_task_release", async (desk) => {
      const t = await board.releaseFor(desk, id.trim());
      return json({ ...taskView(t), next: "the next idle worker that serves the lane claims it; the gate is not run again on the text as it stands now, and is on anything added later" });
    }),
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

  // ---------- access and invites (tokens:write): the chief-of-staff bot approving other agents ----------

  const oauth: OAuthServerOptions = { issuer: opts.oauth?.issuer ?? "relay", ...(opts.oauth?.now ? { now: opts.oauth.now } : {}) };
  const site = opts.oauth?.issuer?.replace(/\/+$/, "");
  const accessView = (r: AccessRequestView) => ({ user_code: r.user_code, client_name: r.client_name, scopes: r.scopes, state: r.state, requested_at: r.created_at, expires_at: r.expires_at });
  const oauthFail = (e: unknown, tool: string) => {
    if (!(e instanceof OAuthError)) return fail(`relay: ${e instanceof Error ? e.message : String(e)}`);
    const next =
      e.status === 403
        ? ""
        : tool === "relay_access_approve"
          ? e.code === "expired_token" || /already|Unknown code/.test(e.description)
            ? " Call relay_access_list to see what is waiting; if the code is not there, ask the device to request a fresh one (it starts the device flow again and shows a new RLAY-XXXX) and approve that."
            : " Codes look like RLAY-XXXX; relay_access_list shows the pending ones."
          : "";
    return fail(`relay: ${e.description}${next}`);
  };

  server.registerTool("relay_access_list", { title: "Pending access requests", description: toolDescription("relay_access_list"), inputSchema: {} }, async () => {
    const g = gate("tokens:write", "relay_access_list");
    if (g) return g;
    const rows = await listRecentAccess(db, oauth);
    const pending = rows.filter((r) => r.state === "pending").map(accessView);
    const approved = rows.filter((r) => r.state === "approved").map(accessView);
    return json({
      pending,
      approved_awaiting_poll: approved,
      count: pending.length,
      ...(pending.length ? { next: "relay_access_approve({ user_code }) approves one; { decision: \"deny\" } refuses it." } : {}),
    });
  });

  server.registerTool(
    "relay_access_approve",
    {
      title: "Approve an access request",
      description: toolDescription("relay_access_approve"),
      inputSchema: {
        user_code: z.string().min(4).max(20).describe("the code the device showed, RLAY-XXXX (case and dashes do not matter)"),
        decision: z.enum(["approve", "deny"]).optional().describe("approve (default) or deny"),
      },
    },
    async ({ user_code, decision }) => {
      const g = gate("tokens:write", "relay_access_approve");
      if (g) return g;
      try {
        const row = await decideDeviceRequest(db, user_code, decision ?? "approve", externalActor(actor), oauth, [...granted]);
        return json({
          user_code: row.user_code,
          status: row.status,
          client_name: row.client_name,
          scopes: row.scopes,
          decided_by: row.actor,
          ...(row.status === "approved" ? { next: `${row.client_name} receives its token (oauth:${row.client_name}) on its next poll of /oauth/token; nothing else to do.` } : {}),
        });
      } catch (e) {
        return oauthFail(e, "relay_access_approve");
      }
    },
  );

  server.registerTool(
    "relay_invite_create",
    {
      title: "Mint an invite code",
      description: toolDescription("relay_invite_create"),
      inputSchema: {
        name: z.string().min(1).max(80).describe("who it is for; the token it yields is named oauth:<name>"),
        scopes: z.array(z.enum(TOKEN_SCOPES as unknown as [string, ...string[]])).min(1).describe("exactly the scopes the token will carry"),
        expires_in: z.union([z.string().min(1), z.number().int().positive()]).optional().describe("a duration like 1h, 24h, 7d, or seconds; default 24h"),
        uses: z.number().int().min(1).max(1000).optional().describe("how many times the code may be redeemed; default 1"),
      },
    },
    async ({ name, scopes, expires_in, uses }) => {
      const g = gate("tokens:write", "relay_invite_create");
      if (g) return g;
      const ttl = expires_in === undefined ? undefined : parseDuration(expires_in);
      if (expires_in !== undefined && !ttl) return fail("relay: expires_in must be a duration like 24h, 7d, or a number of seconds.");
      try {
        const r = await createInvite(db, { name, scopes, ...(ttl ? { expiresInSeconds: ttl } : {}), ...(uses ? { uses } : {}), createdBy: externalActor(actor), creatorScopes: [...granted] }, oauth);
        const where = site ?? "<site>";
        return json({
          invite: r.invite,
          code: r.code,
          setup: `relay setup --site ${where} --invite ${r.code}`,
          redeem: `POST ${where}/oauth/token with grant_type=${GRANT_INVITE} invite=${r.code} client_name=<who is redeeming>`,
          note: "The code is shown once. Hand it to the agent or machine it is for; whoever redeems it gets a token named oauth:" + r.invite.name + " with exactly these scopes and no approval step.",
        });
      } catch (e) {
        return oauthFail(e, "relay_invite_create");
      }
    },
  );

  server.registerTool("relay_invite_revoke", { title: "Revoke an invite", description: toolDescription("relay_invite_revoke"), inputSchema: { id_or_name: z.string().min(1).describe("the invite's id or the name it was created for") } }, async ({ id_or_name }) => {
    const g = gate("tokens:write", "relay_invite_revoke");
    if (g) return g;
    const row = await revokeInvite(db, id_or_name.trim(), externalActor(actor), oauth);
    return row ? json({ revoked: row }) : fail(`relay: no live invite matches '${id_or_name}'; it may be spent, expired or already revoked.`);
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
      return json(row ? { id: row.id, ts: row.ts, kind: row.kind, actor: row.actor } : { deduped: true });
    },
  );

  return server;
}
