/**
 * The brief compiler: the small envelope every model call starts with instead of re-reading the repo.
 *
 * `compileBrief` assembles five sections from memory (review feedback on the task's PR, project summary, matching
 * current decisions, preferences by scope, matching vendor guidance) under a hard token cap. Sections are atomic: the summary and the preferences block
 * are included whole or omitted; the decision and guidance lists include whole items until the budget runs out and
 * are omitted when no item fits. Nothing is ever cut mid-sentence.
 *
 * `renderRulesFile` produces `relay.md` for a linked repo: a ≤2K-token rules file with the hard rules from
 * preferences, the top current decisions, as much of the summary as fits (whole paragraphs), and one line telling the
 * model to use the memory tools.
 */
import type { Db } from "../db/client.ts";
import * as repo from "../db/repo.ts";
import { approxTokens } from "../util.ts";
import type { HarnessConfig } from "../config.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { embedTexts } from "../onboard/embed.ts";
import { reviewNotes } from "../tasks/review.ts";

export interface BriefIssue {
  number?: number;
  title: string;
  body?: string;
}

export type BriefSectionName = "review" | "summary" | "preferences" | "decisions" | "guidance";

export interface CompileBriefOptions {
  /** Project slug; preferences at `project` scope and decisions for this project are selected. */
  project: string;
  issue?: BriefIssue;
  /** What the caller is about to do; used (with the issue text) as the retrieval query. */
  intent: string;
  /** Model id whose vendor guidance should be retrieved (image/video/speech models). Omit for coding lanes. */
  model?: string;
  /** Lane name (`claude|codex|grok`) so lane-scoped preferences are merged in. */
  lane?: string;
  /** Hard cap on the whole envelope, in approximate tokens (≈4 chars/token). */
  maxTokens: number;
  /** Which sections to consider, in priority order. Default: review, preferences, decisions, summary, guidance. */
  sections?: BriefSectionName[];
  /** Optional embedder (set when AI_GATEWAY_API_KEY is configured); vector retrieval is used when it returns a vector. */
  embed?: (text: string) => Promise<number[] | null>;
  /** How many decisions / guidance chunks to retrieve before fitting. */
  k?: number;
}

export interface BriefSection {
  name: BriefSectionName;
  tokens: number;
}

export interface Brief {
  text: string;
  sections: BriefSection[];
  tokens: number;
  /** Sections that were considered but did not fit (or were empty). */
  omitted: BriefSectionName[];
}

/** Default allocation order: the reviewer's notes first (they are why this run exists), then cheapest and most binding; the big summary after; guidance last. */
const DEFAULT_ORDER: BriefSectionName[] = ["review", "preferences", "decisions", "summary", "guidance"];
/** Rendering order is fixed so the envelope always reads the same way. */
const RENDER_ORDER: BriefSectionName[] = ["review", "summary", "preferences", "decisions", "guidance"];

const SCOPE_RANK: Record<repo.PreferenceRow["scope"], number> = { global: 0, project: 1, lane: 2, model: 3 };

/**
 * Preferences that apply to a project (and optionally a lane / model), narrowest scope winning per key.
 * Returns one row per key, sorted by key.
 */
export async function mergedPreferences(db: Db, scope: { project?: string; lane?: string; model?: string }): Promise<repo.PreferenceRow[]> {
  const all = await repo.listPreferences(db);
  const applies = (p: repo.PreferenceRow): boolean => {
    if (p.scope === "global") return true;
    if (p.scope === "project") return !!scope.project && p.scope_id === scope.project;
    if (p.scope === "lane") return !!scope.lane && p.scope_id === scope.lane;
    if (p.scope === "model") return !!scope.model && p.scope_id === scope.model;
    return false;
  };
  const byKey = new Map<string, repo.PreferenceRow>();
  for (const p of all) {
    if (!applies(p)) continue;
    const cur = byKey.get(p.key);
    if (!cur || SCOPE_RANK[p.scope] > SCOPE_RANK[cur.scope]) byKey.set(p.key, p);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function renderPreference(p: repo.PreferenceRow): string {
  const where = p.scope === "global" ? "" : ` (${p.scope}${p.scope_id ? `: ${p.scope_id}` : ""})`;
  return `- ${p.key} = ${p.value}${where}${p.reason ? ` — ${p.reason}` : ""}`;
}

export function renderDecision(d: repo.DecisionRow): string {
  const src = d.source ? ` [${d.source}${d.source_ref ? ` ${shortRef(d.source_ref)}` : ""}]` : "";
  return `- ${d.text}${src}`;
}

const shortRef = (ref: string): string => (ref.length > 40 ? ref.slice(0, 37) + "…" : ref);

/** Current decisions matching a query (text or vector), falling back to the most recent when the search is empty. */
export async function matchingDecisions(db: Db, project: string, query: string, opts: { k?: number; embed?: CompileBriefOptions["embed"] } = {}): Promise<repo.DecisionRow[]> {
  const k = opts.k ?? 12;
  let hits: repo.DecisionRow[] = [];
  if (opts.embed) {
    const v = await opts.embed(query).catch(() => null);
    if (v) hits = await repo.searchDecisions(db, project, v, k);
  }
  if (!hits.length && query.trim()) hits = await repo.searchDecisions(db, project, query, k);
  if (hits.length < k) {
    const seen = new Set(hits.map((h) => h.id));
    const recent = await repo.listDecisions(db, project, { current: true, limit: k });
    for (const r of recent) if (!seen.has(r.id) && hits.length < k) hits.push(r);
  }
  // global decisions (project null) apply everywhere; take a few of the most recent
  const globals = await repo.listDecisions(db, null, { current: true, limit: 4 });
  const seen = new Set(hits.map((h) => h.id));
  for (const g of globals) if (!seen.has(g.id)) hits.push(g);
  return hits;
}

async function matchingGuidance(db: Db, model: string, query: string, opts: { k?: number; embed?: CompileBriefOptions["embed"] }): Promise<repo.GuidanceHit[]> {
  const k = opts.k ?? 8;
  let hits: repo.GuidanceHit[] = [];
  if (opts.embed) {
    const v = await opts.embed(query).catch(() => null);
    if (v) hits = await repo.vectorSearchGuidance(db, model, v, k);
  }
  if (!hits.length) hits = await repo.textSearchGuidance(db, model, query, k);
  return hits;
}

/** Fit whole items under a budget. Returns the items that fit, in order, and the tokens they use. */
function fitItems<T>(items: T[], render: (t: T) => string, budget: number): { lines: string[]; tokens: number } {
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const line = render(it);
    const t = approxTokens(line + "\n");
    if (used + t > budget) continue;
    lines.push(line);
    used += t;
  }
  return { lines, tokens: used };
}

const heading = (title: string): string => `## ${title}\n\n`;

export async function compileBrief(db: Db, opts: CompileBriefOptions): Promise<Brief> {
  const order = opts.sections ?? DEFAULT_ORDER;
  const query = [opts.issue?.title, opts.issue?.body, opts.intent].filter(Boolean).join("\n").slice(0, 4000);
  const project = await repo.getProject(db, opts.project);
  const rendered = new Map<BriefSectionName, { text: string; tokens: number }>();
  const omitted: BriefSectionName[] = [];
  let remaining = Math.max(0, opts.maxTokens);

  for (const name of order) {
    let text = "";
    if (name === "review") {
      // notes a reviewer left with "Request changes" on this issue's PR, or by rejecting the asset it delivered
      // (tasks/review.ts reviewNotes); the next run must address them
      if (project && opts.issue?.number != null) {
        const notes = await reviewNotes(db, { repo: project.repo ?? "", project: project.slug, issue: opts.issue.number });
        if (notes.length) {
          const last = notes.at(-1)!;
          const lead = last.asset
            ? `A reviewer rejected the asset delivered for #${opts.issue.number}. Address every point below and deliver a new version on the same issue (upload it with --replaces ${last.asset} so it becomes the next version).`
            : `A reviewer sent the pull request for #${opts.issue.number} back. Address every point below; the branch and PR already exist and this run replaces the branch.`;
          text =
            heading("Review feedback") +
            `${lead}\n\n` +
            notes.map((n) => `- ${n.at.slice(0, 16)} ${n.by}${n.pr ? ` on PR #${n.pr}` : n.asset ? ` on asset ${n.asset}` : ""}:\n  ${n.note.trim().replace(/\n/g, "\n  ")}`).join("\n") +
            "\n";
        }
      }
      const t = approxTokens(text);
      if (!text || t > remaining) {
        omitted.push(name);
        continue;
      }
      rendered.set(name, { text, tokens: t });
      remaining -= t;
    } else if (name === "summary") {
      if (project?.summary) text = heading(`Project: ${project.slug}`) + project.summary.trim() + "\n";
      const t = approxTokens(text);
      if (!text || t > remaining) {
        omitted.push(name);
        continue;
      }
      rendered.set(name, { text, tokens: t });
      remaining -= t;
    } else if (name === "preferences") {
      const prefs = await mergedPreferences(db, { project: opts.project, ...(opts.lane ? { lane: opts.lane } : {}), ...(opts.model ? { model: opts.model } : {}) });
      if (prefs.length) text = heading("Preferences (hard rules)") + prefs.map(renderPreference).join("\n") + "\n";
      const t = approxTokens(text);
      if (!text || t > remaining) {
        omitted.push(name);
        continue;
      }
      rendered.set(name, { text, tokens: t });
      remaining -= t;
    } else if (name === "decisions") {
      const head = heading("Current decisions");
      const headT = approxTokens(head);
      const items = await matchingDecisions(db, opts.project, query, { embed: opts.embed, ...(opts.k ? { k: opts.k } : {}) });
      const fit = fitItems(items, renderDecision, remaining - headT);
      if (!fit.lines.length) {
        omitted.push(name);
        continue;
      }
      text = head + fit.lines.join("\n") + "\n";
      const t = approxTokens(text);
      rendered.set(name, { text, tokens: t });
      remaining -= t;
    } else if (name === "guidance") {
      if (!opts.model) {
        omitted.push(name);
        continue;
      }
      const head = heading(`Vendor guidance for ${opts.model}`);
      const headT = approxTokens(head);
      const hits = await matchingGuidance(db, opts.model, query, { embed: opts.embed, ...(opts.k ? { k: opts.k } : {}) });
      const fit = fitItems(hits, (h) => `### ${h.title} (${h.kind})\n${h.text.trim()}\nSource: ${h.source_url}\n`, remaining - headT);
      if (!fit.lines.length) {
        omitted.push(name);
        continue;
      }
      text = head + fit.lines.join("\n") + "\n";
      const t = approxTokens(text);
      rendered.set(name, { text, tokens: t });
      remaining -= t;
    }
  }

  const parts: string[] = [];
  const sections: BriefSection[] = [];
  for (const name of RENDER_ORDER) {
    const r = rendered.get(name);
    if (!r) continue;
    parts.push(r.text);
    sections.push({ name, tokens: r.tokens });
  }
  const text = parts.join("\n").trimEnd() + (parts.length ? "\n" : "");
  return { text, sections, tokens: approxTokens(text), omitted };
}

export const RULES_FILE_TOKENS = 2000;

export interface RulesFileOptions {
  /** Repo `owner/name`, used in the one-paragraph description of how relay works here. */
  repo?: string;
  maxTokens?: number;
  /** How many current decisions to consider (most recent first). */
  maxDecisions?: number;
}

/** Render `relay.md` for a project: ≤ maxTokens (default 2000), whole sections and whole paragraphs only. */
export async function renderRulesFile(db: Db, project: string, opts: RulesFileOptions = {}): Promise<{ text: string; tokens: number }> {
  const cap = opts.maxTokens ?? RULES_FILE_TOKENS;
  const p = await repo.getProject(db, project);
  const repoName = opts.repo ?? p?.repo ?? project;
  const header =
    `# relay rules for ${project}\n\n` +
    `Generated by relay from shared memory; do not edit by hand (run \`relay link --refresh\`). ` +
    `This repository is managed with relay: issues labelled \`agent:claude\`, \`agent:codex\` or \`agent:grok\` are picked up by relay workers (machines running \`relay work\` with that vendor's login) that open pull requests from \`relay/<lane>-<issue>\` branches of \`${repoName}\`; a person, or a bot they trust, approves each PR from relay's task page before it merges.\n\n` +
    `Memory tools: call \`relay_recall\` before deciding how to do something, \`relay_decide\` when you settle a durable choice ("we do X because Y"), and \`relay_prefer\` for settings that should hold across sessions. The \`relay\` MCP server provides them; the CLI equivalents are \`relay recall\`, \`relay decide\` and \`relay prefer\`.\n`;
  let remaining = cap - approxTokens(header);
  const parts: string[] = [header];

  const prefs = await mergedPreferences(db, { project });
  if (prefs.length) {
    const block = heading("Hard rules (preferences)") + prefs.map(renderPreference).join("\n") + "\n";
    const t = approxTokens(block);
    if (t <= remaining) {
      parts.push(block);
      remaining -= t;
    }
  }

  const decisions = [...(await repo.listDecisions(db, project, { current: true, limit: opts.maxDecisions ?? 30 })), ...(await repo.listDecisions(db, null, { current: true, limit: 5 }))];
  if (decisions.length) {
    const head = heading("Current decisions");
    const fit = fitItems(decisions, renderDecision, remaining - approxTokens(head));
    if (fit.lines.length) {
      const block = head + fit.lines.join("\n") + "\n";
      parts.push(block);
      remaining -= approxTokens(block);
    }
  }

  if (p?.summary) {
    const head = heading("Project summary");
    const paras = p.summary.trim().split(/\n\s*\n/);
    const fit = fitItems(paras, (x) => x.trim() + "\n", remaining - approxTokens(head));
    if (fit.lines.length) {
      const block = head + fit.lines.join("\n") + (fit.lines.length < paras.length ? "\n(Summary continues in the project record; ask `relay_project`.)\n" : "");
      if (approxTokens(block) <= remaining) {
        parts.push(block);
        remaining -= approxTokens(block);
      }
    }
  }

  const text = parts.join("\n").trimEnd() + "\n";
  return { text, tokens: approxTokens(text) };
}

/** An embedder for compileBrief when the Gateway key is configured; undefined otherwise (full-text retrieval). */
export function briefEmbedder(h: { cfg: HarnessConfig; ledger?: Ledger }): CompileBriefOptions["embed"] | undefined {
  if (!h.cfg.gateway.apiKey) return undefined;
  return async (text) => {
    const v = await embedTexts([text], h.cfg, h.ledger, "brief");
    return v?.[0] ?? null;
  };
}
