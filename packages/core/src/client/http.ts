/**
 * RelayClient over a hosted site: REST under `<site>/api/v1` for feed, projects, tokens, tasks and webhooks, and the
 * site's MCP server at `<site>/mcp` (JSON-RPC `tools/call`, stateless) for the memory tools. One bearer token for both.
 * The token is sent only to the configured site, in the Authorization header, never in a URL.
 */
import type { EventRow } from "../db/events.ts";
import type { DecisionRow, PreferenceRow } from "../db/memory.ts";
import type { InviteRow } from "../db/oauth.ts";
import type { ProjectRow } from "../db/projects.ts";
import type { TaskView } from "../db/tasks.ts";
import type { TokenRow } from "../db/tokens.ts";
import type { PublicWebhook } from "../db/webhooks.ts";
import type { DeliveryResult } from "../webhooks/dispatch.ts";
import type { RelayClient, WhoAmI } from "./types.ts";

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface HttpClientOptions {
  site: string;
  token: string;
  /** Informational: who the token represents (the site derives the real actor from the token). */
  actor?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}

export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly instance: string,
  ) {
    super(`${title} (${status})${detail ? `: ${detail}` : ""} [${instance}]`);
    this.name = "RelayHttpError";
  }
}

export const normalizeSite = (site: string): string => site.trim().replace(/\/+$/, "");

/** Unsupported in site mode by design (the site has no equivalent); the message tells the user what to do instead. */
export class SiteModeError extends Error {
  constructor(what: string, hint = "run this on the machine that holds the database, or remove the site with `relay setup --no-site`") {
    super(`${what} is not available in site mode; ${hint}`);
    this.name = "SiteModeError";
  }
}

export function httpClient(opts: HttpClientOptions): RelayClient {
  const site = normalizeSite(opts.site);
  const doFetch: HttpFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const auth = { authorization: `Bearer ${opts.token}` };

  async function rest<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<{ status: number; body: T }> {
    const url = new URL(`${site}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await doFetch(url.toString(), {
      method,
      headers: { ...auth, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), "user-agent": "relay-cli" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { detail: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { title?: string; detail?: string; instance?: string };
      throw new RelayHttpError(res.status, p.title ?? `HTTP ${res.status}`, p.detail ?? "", p.instance ?? url.pathname);
    }
    return { status: res.status, body: parsed as T };
  }

  /** One MCP tools/call against the site's stateless server. Returns the text content; throws on isError. */
  async function tool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await doFetch(`${site}/mcp`, {
      method: "POST",
      headers: { ...auth, accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": "relay-cli" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    if (!res.ok) throw new RelayHttpError(res.status, res.status === 401 ? "Unauthorized" : `MCP HTTP ${res.status}`, text.slice(0, 200), "/mcp");
    const msg = parseJsonRpc(text);
    if (msg.error) throw new Error(`relay_mcp ${name}: ${msg.error.message}`);
    const content = (msg.result?.content ?? []) as Array<{ type: string; text?: string }>;
    const out = content.map((c) => c.text ?? "").join("\n");
    if (msg.result?.isError) throw new Error(out || `${name} failed`);
    return out;
  }

  const fillEvent = (e: Partial<EventRow>): EventRow => ({ ...(e as EventRow), payload: e.payload ?? {}, dedupe_key: e.dedupe_key ?? null });
  const toProjectRow = (p: Record<string, unknown>): ProjectRow => ({
    slug: String(p.slug),
    repo: (p.repo as string | null) || null,
    path: (p.path as string | null) ?? null,
    stack: (p.stack as string | null) ?? null,
    check_cmd: (p.check_cmd as string | null) ?? null,
    summary: (p.summary as string | null) ?? null,
    summary_tokens: typeof p.summary_tokens === "number" ? p.summary_tokens : null,
    created_at: (p.created_at as string | null) ?? null,
    updated_at: (p.updatedAt as string | null) ?? (p.lastActivity as string | null) ?? null,
  });

  return {
    mode: "site",
    site,
    actor: opts.actor ?? "token:site",

    async listEvents(o = {}) {
      const r = await rest<{ events: Array<Partial<EventRow>> }>("GET", "/feed", undefined, { project: o.project, kind: o.kind, actor: o.actor, lane: o.lane, before: o.before, after: o.after, since: o.since, limit: Math.min(o.limit ?? 50, 200) });
      return r.body.events.map(fillEvent);
    },
    async logEvent(input) {
      const r = await rest<{ event: Partial<EventRow> | null }>("POST", "/events", input);
      return r.body.event ? fillEvent(r.body.event) : undefined;
    },
    async usageSummary(since) {
      const r = await rest<{ subscriptions: Array<{ subscription: string; calls: number; tokens_in: number; tokens_out: number; cache_read: number; cost_equiv: number; avg_ctx: number }> }>("GET", "/usage", undefined, { since });
      return r.body.subscriptions;
    },

    async listProjects() {
      const r = await rest<{ projects: Array<Record<string, unknown>> }>("GET", "/projects");
      return r.body.projects.map(toProjectRow);
    },
    async getProject(slug) {
      try {
        const r = await rest<Record<string, unknown>>("GET", `/projects/${encodeURIComponent(slug)}`);
        return toProjectRow(r.body);
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404) return undefined;
        throw e;
      }
    },
    async registerProject(p) {
      await rest("PUT", `/projects/${encodeURIComponent(p.slug)}`, { repo: p.repo, path: p.path, stack: p.stack, check_cmd: p.checkCmd });
    },
    async putDigests(slug, files, o = {}) {
      const r = await rest<{ files: number }>("PUT", `/projects/${encodeURIComponent(slug)}/digests`, { files, prune: !!o.prune, usage: o.usage ?? [] });
      return { files: r.body.files };
    },
    async putSummary(slug, summary, tokens, o = {}) {
      await rest("PUT", `/projects/${encodeURIComponent(slug)}/summary`, { summary, tokens, usage: o.usage ?? [] });
    },

    async recall(q) {
      const text = await tool("relay_recall", { query: q.query, ...(q.project ? { project: q.project } : {}) });
      return { preferences: [] as PreferenceRow[], decisions: [] as DecisionRow[], text: /^No matching/.test(text) ? "" : text };
    },
    async brief(q) {
      const text = await tool("relay_brief", { project: q.project, intent: q.issue ? `${q.intent}: ${q.issue.title}${q.issue.body ? `\n${q.issue.body.slice(0, 2000)}` : ""}` : q.intent, max_tokens: Math.max(200, Math.min(q.maxTokens, 3000)), ...(q.model ? { model: q.model } : {}) });
      const body = /^Memory is empty/.test(text) ? "" : text;
      return { text: body, tokens: Math.ceil(body.length / 4) };
    },
    async decide(d) {
      if (!d.project) throw new SiteModeError("a global decision", "pass --project <slug>; the site's relay_decide tool is project-scoped");
      const out = await tool("relay_decide", { text: d.text, project: d.project, source: d.source, ...(d.supersedesId ? { supersedes_id: d.supersedesId } : {}) });
      const m = /#(\d+)/.exec(out);
      return { id: m ? Number(m[1]) : 0 };
    },
    async prefer(p) {
      await tool("relay_prefer", { key: p.key, value: p.value, scope: p.scope, ...(p.scopeId ? { scope_id: p.scopeId } : {}), ...(p.reason ? { reason: p.reason } : {}) });
    },
    async listDecisions(project, o = {}) {
      if (!project) throw new SiteModeError("listing global decisions", "pass --project <slug>");
      const r = await rest<{ decisions: DecisionRow[] }>("GET", `/projects/${encodeURIComponent(project)}/decisions`, undefined, { current: o.current ? 1 : undefined, limit: o.limit });
      return r.body.decisions;
    },

    async createToken(i) {
      const r = await rest<TokenRow & { token: string }>("POST", "/tokens", { name: i.name, scopes: i.scopes });
      const { token, ...row } = r.body;
      return { token, row };
    },
    async listTokens(o = {}) {
      const r = await rest<{ tokens: TokenRow[] }>("GET", "/tokens", undefined, { all: o.includeRevoked ? 1 : undefined });
      return r.body.tokens;
    },
    async revokeToken(idOrName) {
      try {
        const r = await rest<{ revoked: TokenRow }>("DELETE", `/tokens/${encodeURIComponent(idOrName)}`);
        return r.body.revoked;
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404) return undefined;
        throw e;
      }
    },

    async createInvite(i) {
      const r = await rest<{ invite: InviteRow; code: string }>("POST", "/invites", { name: i.name, scopes: i.scopes, expires_in: i.expiresInSeconds, uses: i.uses });
      return r.body;
    },
    async listInvites(o = {}) {
      const r = await rest<{ invites: InviteRow[] }>("GET", "/invites", undefined, { all: o.includeSpent ? 1 : undefined });
      return r.body.invites;
    },
    async revokeInvite(idOrName) {
      try {
        const r = await rest<{ revoked: InviteRow }>("DELETE", `/invites/${encodeURIComponent(idOrName)}`);
        return r.body.revoked;
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404) return undefined;
        throw e;
      }
    },
    async whoami() {
      const r = await rest<WhoAmI>("GET", "/whoami");
      return r.body;
    },

    async createTask(input) {
      const r = await rest<{ task_id: string; issue_url: string; created: boolean; task: TaskView }>("POST", "/tasks", input);
      return r.body;
    },
    async getTask(id) {
      try {
        const r = await rest<TaskView>("GET", `/tasks/${taskPath(id)}`);
        return r.body;
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404) return undefined;
        throw e;
      }
    },
    async listTasks(o = {}) {
      const r = await rest<{ tasks: TaskView[] }>("GET", "/tasks", undefined, { project: o.project, state: o.state, limit: o.limit });
      return r.body.tasks;
    },
    async approveTask(id) {
      const r = await rest<TaskView>("POST", `/tasks/${taskPath(id)}/approve`, {});
      return r.body;
    },
    async requestChanges(id, note) {
      const r = await rest<TaskView>("POST", `/tasks/${taskPath(id)}/request-changes`, { note });
      return r.body;
    },

    async addWebhook(input) {
      const r = await rest<{ webhook: PublicWebhook; secret: string }>("POST", "/webhooks", input);
      return r.body;
    },
    async listWebhooks(o = {}) {
      const r = await rest<{ webhooks: PublicWebhook[] }>("GET", "/webhooks", undefined, { project: o.project });
      return r.body.webhooks;
    },
    async removeWebhook(id) {
      try {
        await rest("DELETE", `/webhooks/${encodeURIComponent(id)}`);
        return true;
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404) return false;
        throw e;
      }
    },
    async testWebhook(id) {
      const r = await rest<DeliveryResult>("POST", `/webhooks/${encodeURIComponent(id)}/test`);
      return r.body;
    },

    async health() {
      try {
        const info = await rest<{ name?: string; version?: string }>("GET", "/info");
        try {
          await rest("GET", "/projects", undefined, { limit: 1 });
          return { ok: true, detail: `${site} answers (${info.body.name ?? "relay"} ${info.body.version ?? ""}); token accepted` };
        } catch (e) {
          if (e instanceof RelayHttpError && (e.status === 401 || e.status === 403)) return { ok: false, detail: `${site} answers but rejects the token (${e.status}); run relay setup --site ${site} to approve this machine again` };
          throw e;
        }
      } catch (e) {
        return { ok: false, detail: `${site} unreachable: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    close: async () => {},
  };
}

/** `owner/repo#12` -> `owner/repo%2312`: the slash stays a path separator, the hash is escaped. */
export function taskPath(id: string): string {
  const i = id.lastIndexOf("#");
  return i < 0 ? encodeURIComponent(id) : `${id.slice(0, i)}%23${encodeURIComponent(id.slice(i + 1))}`;
}

interface JsonRpcMessage {
  result?: { content?: unknown[]; isError?: boolean };
  error?: { code: number; message: string };
}

/** The stateless server answers JSON; an SSE body (one `data:` line) is accepted too. */
export function parseJsonRpc(text: string): JsonRpcMessage {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t) as JsonRpcMessage;
  for (const line of t.split("\n")) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload) return JSON.parse(payload) as JsonRpcMessage;
    }
  }
  throw new Error(`unreadable MCP response: ${t.slice(0, 120)}`);
}
