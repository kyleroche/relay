/** RelayClient over a database handle: what the CLI uses without a site (PGlite locally, DATABASE_URL in production). */
import { compileBrief, matchingDecisions, mergedPreferences, renderDecision, renderPreference, type CompileBriefOptions } from "../brief/index.ts";
import type { Db } from "../db/client.ts";
import { currentVersion } from "../db/migrate.ts";
import * as repo from "../db/repo.ts";
import { detectGitHub, type GitHubClient } from "../github/client.ts";
import { createInvite, listInvites, revokeInvite } from "../oauth/server.ts";
import { TOKEN_SCOPES } from "../db/tokens.ts";
import { openTask } from "../tasks/create.ts";
import { deliverWebhook, dispatchEvent, pingPayload, type DeliverOptions } from "../webhooks/dispatch.ts";
import type { RelayClient } from "./types.ts";

export interface LocalClientOptions {
  actor: string;
  embed?: CompileBriefOptions["embed"];
  /** GitHub access for opening tasks; default: env token, then the gh CLI. */
  github?: GitHubClient | (() => GitHubClient | undefined);
  /** Deliver matching webhooks after every event written here (default true). */
  dispatch?: boolean;
  deliver?: Omit<DeliverOptions, "db">;
  /** Called after the client is closed. */
  onClose?: () => Promise<void>;
  /** The issuer invites are minted for (only used in the invite's feed events). */
  issuer?: string;
}

export const EXTERNAL_KIND = /^external\.[a-z0-9_.-]+$/i;

export function localClient(db: Db, opts: LocalClientOptions): RelayClient {
  const github = () => (typeof opts.github === "function" ? opts.github() : opts.github ?? detectGitHub());
  const embed = opts.embed;
  const afterWrite = async (row: repo.EventRow | undefined) => {
    if (!row || opts.dispatch === false) return;
    await dispatchEvent(db, row, opts.deliver ?? {}).catch(() => {});
  };
  return {
    mode: "local",
    actor: opts.actor,

    listEvents: (o = {}) => repo.listEvents(db, o),
    async logEvent(input) {
      if (!EXTERNAL_KIND.test(input.kind)) throw new Error("kind must start with 'external.'");
      const actor = opts.actor.startsWith("token:") ? `bot:${opts.actor.slice(6)}` : opts.actor;
      const row = await repo.writeEvent(db, {
        kind: input.kind,
        actor,
        project: input.project ?? null,
        summary: input.summary,
        url: input.url ?? null,
        cost_equiv: input.cost_equiv ?? 0,
        payload: { ...(input.payload ?? {}), ...(input.source ? { source: input.source } : {}) },
      });
      await afterWrite(row);
      return row;
    },
    usageSummary: (since) => repo.usageSummary(db, since),

    listProjects: () => repo.listProjects(db),
    getProject: (slug) => repo.getProject(db, slug),
    registerProject: (p) => repo.upsertProject(db, p),
    async putDigests(slug, files, o = {}) {
      await repo.upsertFileDigests(db, slug, files.map(({ path, sha256, size }) => ({ path, sha256, size })));
      const summarized = files.filter((f): f is typeof f & { summary: string } => typeof f.summary === "string" && !!f.summary);
      await repo.setFileSummaries(db, slug, summarized.map((f) => ({ path: f.path, summary: f.summary, tokens: f.tokens ?? 0, sha256: f.summary_sha ?? f.sha256 })));
      if (o.prune) await repo.removeMissingFileDigests(db, slug, files.map((f) => f.path));
      await recordUsage(db, slug, o.usage);
      return { files: files.length };
    },
    async putSummary(slug, summary, tokens, o = {}) {
      await repo.setProjectSummary(db, slug, summary, tokens);
      await recordUsage(db, slug, o.usage);
    },

    async recall(q) {
      if (q.project) {
        const preferences = await mergedPreferences(db, { project: q.project, ...(q.lane ? { lane: q.lane } : {}) });
        const decisions = q.query.trim() ? await matchingDecisions(db, q.project, q.query, { ...(embed ? { embed } : {}) }) : await repo.listDecisions(db, q.project, { current: true, limit: 50 });
        return { preferences, decisions, text: renderRecall(preferences, decisions) };
      }
      const preferences = await repo.listPreferences(db, "global");
      const decisions = q.query.trim() ? await repo.searchDecisions(db, undefined, q.query, 12) : await repo.listDecisions(db, undefined, { current: true, limit: 12 });
      return { preferences, decisions, text: renderRecall(preferences, decisions) };
    },
    async brief(q) {
      const b = await compileBrief(db, {
        project: q.project,
        intent: q.intent,
        maxTokens: q.maxTokens,
        sections: ["summary", "preferences", "decisions", "guidance"],
        ...(q.issue ? { issue: q.issue } : {}),
        ...(q.model ? { model: q.model } : {}),
        ...(q.lane ? { lane: q.lane } : {}),
        ...(embed ? { embed } : {}),
      });
      return { text: b.text, tokens: b.tokens, sections: b.sections, omitted: b.omitted };
    },
    async decide(d) {
      const row = d.supersedesId
        ? await repo.supersedeDecision(db, d.supersedesId, { text: d.text, source: d.source, ...(d.sourceRef ? { sourceRef: d.sourceRef } : {}) })
        : await repo.addDecision(db, { project: d.project, text: d.text, source: d.source, ...(d.sourceRef ? { sourceRef: d.sourceRef } : {}) });
      const ev = await repo.writeEvent(db, { kind: "decision.captured", actor: opts.actor, project: d.project, summary: d.text.slice(0, 200), payload: { decision_id: row.id, source: d.source, source_ref: d.sourceRef ?? null, superseded: d.supersedesId ?? null } });
      await afterWrite(ev);
      return { id: row.id };
    },
    async prefer(p) {
      await repo.upsertPreference(db, { key: p.key, value: p.value, scope: p.scope, scope_id: p.scopeId, reason: p.reason ?? null });
      const ev = await repo.writeEvent(db, { kind: "preference.set", actor: opts.actor, project: p.scope === "project" ? p.scopeId : null, summary: `${p.key} = ${p.value} (${p.scope}${p.scopeId ? `: ${p.scopeId}` : ""})`, payload: { key: p.key, value: p.value, scope: p.scope, scope_id: p.scopeId, reason: p.reason ?? null } });
      await afterWrite(ev);
    },
    listDecisions: (project, o = {}) => repo.listDecisions(db, project, o),

    createToken: (i) => repo.createToken(db, { name: i.name, scopes: i.scopes, createdBy: opts.actor }),
    listTokens: (o = {}) => repo.listTokens(db, o),
    revokeToken: (idOrName) => repo.revokeToken(db, idOrName),

    async createTask(input) {
      const r = await openTask(db, github(), { ...input, actor: opts.actor });
      for (const ev of r.events) await afterWrite(ev);
      return { task_id: r.task_id, issue_url: r.issue_url, created: r.created, task: r.task };
    },
    async getTask(id) {
      const t = await repo.getTask(db, id);
      return t ? repo.taskView(db, t) : undefined;
    },
    listTasks: (o = {}) => repo.listTaskViews(db, o),

    async createInvite(i) {
      const r = await createInvite(db, { name: i.name, scopes: i.scopes, ...(i.expiresInSeconds ? { expiresInSeconds: i.expiresInSeconds } : {}), ...(i.uses ? { uses: i.uses } : {}), createdBy: opts.actor }, { issuer: opts.issuer ?? "relay://local" });
      return r;
    },
    listInvites: (o = {}) => listInvites(db, o),
    revokeInvite: (idOrName) => revokeInvite(db, idOrName, opts.actor),
    whoami: async () => ({ actor: opts.actor, name: opts.actor, scopes: [...TOKEN_SCOPES], expires_at: null, source: "local" }),

    async addWebhook(input) {
      const row = await repo.createWebhook(db, { project: input.project ?? null, url: input.url, events: input.events, bearer: input.bearer ?? null, ...(input.secret ? { secret: input.secret } : {}), createdBy: opts.actor });
      return { webhook: repo.publicWebhook(row), secret: row.secret };
    },
    listWebhooks: async (o = {}) => (await repo.listWebhooks(db, { ...(o.project ? { project: o.project } : {}), includeInactive: true })).map(repo.publicWebhook),
    removeWebhook: (id) => repo.deleteWebhook(db, id),
    async testWebhook(id) {
      const hook = await repo.getWebhook(db, id);
      if (!hook) throw new Error(`no webhook ${id}`);
      return deliverWebhook(hook, pingPayload(hook), { ...(opts.deliver ?? {}), db });
    },

    async health() {
      try {
        const v = await currentVersion(db);
        return { ok: v > 0, detail: `${db.driver}, schema v${v}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    close: async () => {
      await opts.onClose?.();
    },
  };
}

function renderRecall(prefs: repo.PreferenceRow[], decisions: repo.DecisionRow[]): string {
  const parts: string[] = [];
  if (prefs.length) parts.push("Preferences:\n" + prefs.map(renderPreference).join("\n"));
  if (decisions.length) parts.push("Decisions:\n" + decisions.map((d) => renderDecision(d) + (d.project ? "" : " (global)")).join("\n"));
  return parts.join("\n\n");
}

/** `step.usage` rows a site-mode `relay link` made locally; written here so the ledger stays complete. */
async function recordUsage(db: Db, project: string, usage: Array<{ lane: string; model: string | null; subscription: string | null; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number; cost_equiv: number; duration_ms: number | null; summary: string; ts: string }> | undefined): Promise<void> {
  if (!usage?.length) return;
  for (const u of usage) {
    await repo.writeEvent(db, {
      kind: "step.usage",
      actor: "agent:anthropic",
      project,
      lane: u.lane,
      model: u.model,
      subscription: u.subscription,
      tokens_in: u.tokens_in,
      tokens_out: u.tokens_out,
      cache_read: u.cache_read,
      cache_write: u.cache_write,
      cost_equiv: u.cost_equiv,
      duration_ms: u.duration_ms,
      summary: u.summary,
      ts: u.ts,
      payload: { provider: "anthropic", uploaded: true },
      dedupe_key: `usage:${project}:${u.ts}:${u.tokens_in}:${u.tokens_out}`,
    });
  }
}
