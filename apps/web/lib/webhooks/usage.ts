/**
 * The runner's usage comment (docs/FEED.md, "The usage comment"): a PR comment ending with `<!-- relay:usage -->`
 * and a fenced json block. Parsed here into a `step.usage` event (and a `pr.review` row in review mode).
 *
 * Trust: only comments by logins in RELAY_ALLOWED_SENDERS (env, comma-separated) or in the repo's Actions variable
 * of the same name (read through the GitHub API with GITHUB_TOKEN, cached an hour) count towards the ledger. An
 * untrusted block is still recorded, with `payload.untrusted = true` and its usage columns zeroed so the ledger view
 * (a plain `kind = 'step.usage'` filter) excludes it; the raw numbers stay in the payload. With neither source
 * configured every sender is trusted, which is the right default for a single-owner deployment.
 */
import { costEquiv } from "@relay/core";
import type { Lane, NewEvent, Subscription } from "@/lib/types";

export const USAGE_MARKER = "<!-- relay:usage -->";

const LANES: Lane[] = ["claude", "codex", "grok"];
const SUBSCRIPTION: Record<string, Subscription> = { claude: "max", codex: "codex", grok: "grok", gateway: "gateway" };

export interface UsageBlock {
  lane: Lane | "gateway";
  mode: "code" | "review";
  tool?: string;
  model: string;
  issue?: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  duration_ms: number;
  extra: Record<string, unknown>;
}

const nonNeg = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The parsed block, or undefined when the comment carries no valid usage block. */
export function parseUsageComment(body: string): UsageBlock | undefined {
  const at = body.indexOf(USAGE_MARKER);
  if (at < 0) return undefined;
  const after = body.slice(at + USAGE_MARKER.length);
  const fence = /```json[^\n]*\n([\s\S]*?)```/.exec(after);
  if (!fence?.[1]) return undefined;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fence[1].trim()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (j.relay !== "step.usage") return undefined;
  const lane = j.lane;
  if (typeof lane !== "string" || !(LANES.includes(lane as Lane) || lane === "gateway")) return undefined;
  if (typeof j.model !== "string" || !j.model) return undefined;
  for (const k of ["tokens_in", "tokens_out", "cache_read", "cache_write", "duration_ms"]) if (!nonNeg(j[k])) return undefined;
  const mode = j.mode === "review" ? "review" : "code";
  const { relay: _r, lane: _l, mode: _m, tool, model, issue, tokens_in, tokens_out, cache_read, cache_write, duration_ms, ...extra } = j;
  return {
    lane: lane as Lane | "gateway",
    mode,
    ...(typeof tool === "string" ? { tool } : {}),
    model: model as string,
    ...(nonNeg(issue) ? { issue } : {}),
    tokens_in: tokens_in as number,
    tokens_out: tokens_out as number,
    cache_read: cache_read as number,
    cache_write: cache_write as number,
    duration_ms: duration_ms as number,
    extra,
  };
}

/** The text above the marker, for the review summary. */
export function textAboveMarker(body: string): string {
  const at = body.indexOf(USAGE_MARKER);
  return (at < 0 ? body : body.slice(0, at)).replace(/^##\s+Summary from the \w+ lane\s*/i, "").trim();
}

// ---------- trusted senders ----------

declare global {
  // eslint-disable-next-line no-var
  var __relaySenders: Map<string, { at: number; logins: Set<string> | null }> | undefined;
}
const cache = (globalThis.__relaySenders ??= new Map());
const HOUR = 3_600_000;

/** True when the login may write usage; see the module comment for the sources. */
export async function senderTrusted(repo: string | null, login: string): Promise<boolean> {
  const env = process.env.RELAY_ALLOWED_SENDERS;
  if (env?.trim()) return env.split(",").map((s) => s.trim().toLowerCase()).includes(login.toLowerCase());
  const token = process.env.GITHUB_APP_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || !repo) return true;
  const hit = cache.get(repo);
  if (!hit || Date.now() - hit.at > HOUR) {
    let logins: Set<string> | null = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/variables/RELAY_ALLOWED_SENDERS`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "relay-web", "x-github-api-version": "2022-11-28" },
      });
      if (res.ok) {
        const j = (await res.json()) as { value?: string };
        logins = new Set((j.value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
      }
    } catch {
      /* unreachable: trust, and retry next hour */
    }
    cache.set(repo, { at: Date.now(), logins });
  }
  const logins = cache.get(repo)?.logins;
  return logins ? logins.has(login.toLowerCase()) : true;
}

/** The step.usage row (and the pr.review row in review mode) for a parsed comment. */
export function usageEvents(block: UsageBlock, ctx: { repo: string | null; project: string | null; pr: number | null; url: string | null; commentId: number | string; sender: string; body: string; trusted: boolean; ts?: string }): NewEvent[] {
  const lane = block.lane === "gateway" ? null : block.lane;
  const subscription = SUBSCRIPTION[block.lane] ?? null;
  const cost = costEquiv({ lane: block.lane, model: block.model, provider: block.lane, subscription: subscription ?? "gateway", tokens_in: block.tokens_in, tokens_out: block.tokens_out, cache_read: block.cache_read, cache_write: block.cache_write, duration_ms: block.duration_ms });
  const usage = ctx.trusted
    ? { tokens_in: block.tokens_in, tokens_out: block.tokens_out, cache_read: block.cache_read, cache_write: block.cache_write, cost_equiv: cost }
    : { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_equiv: 0 };
  const events: NewEvent[] = [
    {
      kind: "step.usage",
      actor: `agent:${block.lane}`,
      repo: ctx.repo,
      project: ctx.project,
      issue: block.issue ?? null,
      pr: ctx.pr,
      lane,
      model: block.model,
      subscription,
      ...usage,
      duration_ms: block.duration_ms,
      url: ctx.url,
      summary: `${block.model}: ${block.tokens_in}+${block.cache_read} in, ${block.tokens_out} out`,
      payload: {
        ...block.extra,
        mode: block.mode,
        ...(block.tool ? { tool: block.tool } : {}),
        sender: ctx.sender,
        ...(ctx.trusted ? {} : { untrusted: true, reported: { tokens_in: block.tokens_in, tokens_out: block.tokens_out, cache_read: block.cache_read, cache_write: block.cache_write, cost_equiv: cost } }),
      },
      dedupe_key: `gh-comment:${ctx.commentId}`,
      ...(ctx.ts ? { ts: ctx.ts } : {}),
    },
  ];
  if (block.mode === "review" && ctx.pr) {
    const first = textAboveMarker(ctx.body).split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";
    events.push({
      kind: "pr.review",
      actor: `agent:${block.lane}`,
      repo: ctx.repo,
      project: ctx.project,
      issue: block.issue ?? null,
      pr: ctx.pr,
      lane,
      model: block.model,
      url: ctx.url,
      summary: first ? `Reviewed #${ctx.pr}: ${first}` : `Reviewed #${ctx.pr}`,
      payload: { state: "commented", mode: "review", comment_id: ctx.commentId },
      dedupe_key: `gh-comment-review:${ctx.commentId}`,
      ...(ctx.ts ? { ts: ctx.ts } : {}),
    });
  }
  return events;
}
