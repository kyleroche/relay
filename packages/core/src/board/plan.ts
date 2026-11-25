/**
 * A plan: what a planning task proposes instead of a change (docs/STEPS.md, "plan"). The lane ends its answer with a
 * fenced `relay-plan` block of JSON; the runner checks it, posts it in the thread as `plan.json` and holds the task
 * for a person. Approving the plan opens its tasks as the approver, each waiting for the ones it needs. Nothing a
 * plan says is acted on before that approval.
 */
import { isLaneName } from "../tasks/lanes.ts";
import { isBranchName, PROJECT_SLUG } from "./mapping.ts";

export const PLAN_FENCE = "relay-plan";
export const PLAN_FILE = "plan.json";
export const PLAN_MAX_TASKS = 20;

export interface PlanTask {
  /** A short name the plan's own tasks use to say what they wait for. */
  key: string;
  title: string;
  body: string;
  lane: string;
  model?: string;
  /** Keys of the plan's tasks that must complete first. */
  needs?: string[];
  /** Another project's queue and repository, for work that crosses repositories; the plan task's own without them. */
  project?: string;
  repo?: string;
  base?: string;
}

export interface Plan {
  tasks: PlanTask[];
}

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Why a plan cannot be opened as it is, or undefined. Every task must be one a stranger could run, and the order must exist. */
export function planProblem(v: unknown): string | undefined {
  const tasks = (v as Plan | null)?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) return "a plan is { \"tasks\": [ … ] } with at least one task";
  if (tasks.length > PLAN_MAX_TASKS) return `a plan holds at most ${PLAN_MAX_TASKS} tasks; this one has ${tasks.length}`;
  const keys = new Set<string>();
  for (const [i, t] of tasks.entries()) {
    const at = `task ${i + 1}`;
    if (!t || typeof t !== "object") return `${at} is not an object`;
    if (typeof t.key !== "string" || !KEY.test(t.key)) return `${at} needs a key (lowercase letters, digits and dashes)`;
    if (keys.has(t.key)) return `the key '${t.key}' is used twice`;
    keys.add(t.key);
    if (typeof t.title !== "string" || !t.title.trim() || t.title.length > 200) return `${at} (${t.key}) needs a title of at most 200 characters`;
    if (typeof t.body !== "string" || t.body.trim().length < 40) return `${at} (${t.key}) needs a body a stranger could work from: what to do, what is out of scope, and how to tell it is done`;
    if (t.body.length > 20_000) return `${at} (${t.key}): the body is over 20,000 characters`;
    if (typeof t.lane !== "string" || !isLaneName(t.lane)) return `${at} (${t.key}) needs a lane`;
    if (t.model !== undefined && (typeof t.model !== "string" || !MODEL.test(t.model))) return `${at} (${t.key}): '${String(t.model)}' is not a model id`;
    if (t.project !== undefined && (typeof t.project !== "string" || !PROJECT_SLUG.test(t.project))) return `${at} (${t.key}): '${String(t.project)}' is not a project slug`;
    if (t.repo !== undefined && (typeof t.repo !== "string" || !REPO.test(t.repo))) return `${at} (${t.key}): repo must be owner/name`;
    if (t.base !== undefined && (typeof t.base !== "string" || !isBranchName(t.base))) return `${at} (${t.key}): '${String(t.base)}' is not a branch name`;
    if (t.needs !== undefined && (!Array.isArray(t.needs) || t.needs.some((n) => typeof n !== "string"))) return `${at} (${t.key}): needs is a list of keys`;
  }
  for (const t of tasks) for (const n of t.needs ?? []) if (!keys.has(n)) return `'${t.key}' needs '${n}', which is not a task of this plan`;
  if (!planOrder({ tasks })) return "the tasks wait for each other in a circle";
  return undefined;
}

/** The plan's tasks in an order where each comes after everything it needs; undefined when no such order exists. */
export function planOrder(plan: Plan): PlanTask[] | undefined {
  const left = new Map(plan.tasks.map((t) => [t.key, t]));
  const out: PlanTask[] = [];
  while (left.size) {
    const ready = [...left.values()].filter((t) => (t.needs ?? []).every((n) => !left.has(n)));
    if (!ready.length) return undefined;
    for (const t of ready) {
      out.push(t);
      left.delete(t.key);
    }
  }
  return out;
}

/**
 * The plan a lane proposed, from the last `relay-plan` fence of what it said. `plan` when there is one and it holds
 * up, `problem` when there is a fence and it does not, neither when the answer carries no plan at all.
 */
export function parsePlan(text: string): { plan?: Plan; problem?: string } {
  const fences = [...text.matchAll(/^(`{3,}|~{3,})[^\S\r\n]*relay-plan[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1[^\S\r\n]*$/gm)];
  const last = fences.at(-1);
  if (!last) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[2]!);
  } catch (e) {
    return { problem: `the relay-plan block is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const problem = planProblem(parsed);
  if (problem) return { problem };
  const tasks = (parsed as Plan).tasks.map((t) => ({
    key: t.key,
    title: t.title.trim().replace(/\s+/g, " "),
    body: t.body.trim(),
    lane: t.lane,
    ...(t.model ? { model: t.model } : {}),
    ...(t.needs?.length ? { needs: [...new Set(t.needs)] } : {}),
    ...(t.project ? { project: t.project } : {}),
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.base ? { base: t.base } : {}),
  }));
  return { plan: { tasks } };
}

/** A plan as a person reads it in the thread before approving: each task, what it waits for, and where it runs. */
export function planSummary(plan: Plan): string {
  const lines = [`Proposed plan: ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}. Approving it opens them; nothing is opened before that. Each task is shown by its first line only: its whole text, which is what a lane will be given, is in the attached ${PLAN_FILE}.`, ""];
  for (const [i, t] of (planOrder(plan) ?? plan.tasks).entries()) {
    const where = [t.lane, t.model, t.repo ?? t.project].filter(Boolean).join(", ");
    lines.push(`${i + 1}. **${t.title}** (${t.key}; ${where})${t.needs?.length ? ` after ${t.needs.join(", ")}` : ""}`, `   ${t.body.split("\n").find((l) => l.trim())?.trim().slice(0, 240) ?? ""}`);
  }
  return lines.join("\n");
}
