import { releaseServer, type RunUsage } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { int, needsDb, readJson, str } from "@/lib/integrations";
import { taskIdFrom, workProblem } from "@/lib/work";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ owner: string; task: string }> };

const OUTCOMES = ["finished", "failed", "released", "held"] as const;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => String(s).slice(0, 300)).filter(Boolean).slice(0, 8) : []);

/** The gate's verdict a `held` release carries (packages/core/src/tasks/gate.ts). */
function gateOf(v: unknown): { score: number; reasons: string[]; grader: "precheck" | "model" | "off"; model: string | null } | null {
  if (!v || typeof v !== "object") return null;
  const g = v as Record<string, unknown>;
  const grader = g.grader === "model" || g.grader === "off" ? g.grader : "precheck";
  return { score: Math.min(1, nonNeg(g.score)), reasons: strList(g.reasons), grader, model: str(g.model) ?? null };
}
const nonNeg = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function usageOf(v: unknown): RunUsage | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Record<string, unknown>;
  return {
    tool: str(u.tool) ?? "lane",
    model: str(u.model) ?? null,
    subscription: str(u.subscription) ?? null,
    tokens_in: Math.round(nonNeg(u.tokens_in)),
    tokens_out: Math.round(nonNeg(u.tokens_out)),
    cache_read: Math.round(nonNeg(u.cache_read)),
    cache_write: Math.round(nonNeg(u.cache_write)),
    cost_equiv: nonNeg(u.cost_equiv),
    duration_ms: Math.round(nonNeg(u.duration_ms)),
  };
}

/**
 * operationId: releaseWork. Path: /work/{owner}/{repo}%23{issue}/release. Body: { worker_id, outcome: finished | failed |
 * released | held, conclusion?, summary?, error?, pr?, pr_url?, duration_ms?, usage?, gate?, gate_usage? }. Ends the
 * worker's lease and writes run.finished (with the PR) or run.failed, plus one step.usage row from `usage`. `released`
 * only frees the lease (the task is queued again). `held` frees it and writes task.held from `gate` (the injection gate
 * flagged the text; the task waits for a release). `gate_usage` is the gate's own model call, a step.usage row on lane
 * `gate`. 409 when the worker holds no live claim.
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const { owner, task } = await ctx.params;
    const id = taskIdFrom(owner, task);
    if (!id) return problem(400, "Bad Request", "task id must be owner/repo#n.", instance, { parameter: "task" });
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const workerId = str(body.worker_id);
    if (!workerId) return problem(400, "Bad Request", "worker_id is required.", instance, { parameter: "worker_id" });
    const outcome = str(body.outcome) as (typeof OUTCOMES)[number] | undefined;
    if (!outcome || !OUTCOMES.includes(outcome)) return problem(400, "Bad Request", `outcome must be one of ${OUTCOMES.join(", ")}.`, instance, { parameter: "outcome" });
    const prUrl = str(body.pr_url);
    if (prUrl && !/^https?:\/\//.test(prUrl)) return problem(400, "Bad Request", "pr_url must be http(s).", instance, { parameter: "pr_url" });
    try {
      const r = await releaseServer(await getDb(), id, {
        worker_id: workerId,
        outcome,
        ...(str(body.conclusion) ? { conclusion: str(body.conclusion)! } : {}),
        ...(str(body.summary) ? { summary: str(body.summary)! } : {}),
        ...(str(body.error) ? { error: str(body.error)! } : {}),
        pr: int(body.pr) ?? null,
        pr_url: prUrl ?? null,
        duration_ms: int(body.duration_ms) ?? null,
        usage: usageOf(body.usage),
        gate: gateOf(body.gate),
        gate_usage: usageOf(body.gate_usage),
      });
      dispatchAfter(r.events);
      return json({ claim: r.claim, events: r.events.map((e) => ({ id: e.id, kind: e.kind })) });
    } catch (e) {
      return workProblem(e, instance) ?? Promise.reject(e);
    }
  },
  { scope: "work:claim" },
);
