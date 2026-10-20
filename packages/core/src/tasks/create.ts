/**
 * Opening a task: one function behind the `relay_task_create` tool, `POST /api/v1/tasks` and `relay task create`.
 * It opens the GitHub issue with the lane label (a priority label when asked, and `production:<slug>` when the
 * project's repository is shared by other projects), records the task row, and writes `issue.opened` and
 * `task.created` to the feed. With an idempotency key a second call returns the first task and opens nothing. The
 * issue body ends with a hidden marker so the task can be traced back from GitHub.
 *
 * The injection gate's pre-check (gate.ts) runs on the title and body here, on whichever side opened the task (the
 * site has no vendor login, so only the deterministic part runs at creation; the model grade happens on the worker):
 * a hit writes `task.held` right away and the task is `held` before any worker can claim it.
 */
import type { Db } from "../db/client.ts";
import { writeEvent, type EventRow } from "../db/events.ts";
import { getProject, projectsOnRepo } from "../db/projects.ts";
import { createTask, findTaskByKey, taskView, type TaskView } from "../db/tasks.ts";
import type { GitHubClient } from "../github/client.ts";
import { ulid } from "../util.ts";
import { heldEvent, precheckTask } from "./gate.ts";

/**
 * Worker lanes execute on a machine that ran `relay work`; cloud lanes are dispatched by the site to the vendor's hosted
 * tier. `nodes` is the Griptape Nodes lane: a worker with the engine installed runs the workflow the issue's manifest
 * names and uploads the outputs as assets on the issue (no branch, no PR; `lanes/nodes.ts`, docs/WORKERS.md).
 */
export const WORKER_LANES = ["claude", "codex", "grok", "nodes"] as const;
export const CLOUD_LANES = ["claude-cloud", "codex-cloud"] as const;
export const TASK_LANES = [...WORKER_LANES, ...CLOUD_LANES] as const;
export type WorkerLane = (typeof WORKER_LANES)[number];
export type CloudLane = (typeof CLOUD_LANES)[number];
export type TaskLane = (typeof TASK_LANES)[number];
export const isTaskLane = (s: string): s is TaskLane => (TASK_LANES as readonly string[]).includes(s);
export const isWorkerLane = (s: string): s is WorkerLane => (WORKER_LANES as readonly string[]).includes(s);
export const isCloudLane = (s: string): s is CloudLane => (CLOUD_LANES as readonly string[]).includes(s);
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const isTaskPriority = (s: string): s is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(s);

export interface CreateTaskInput {
  project: string;
  title: string;
  body?: string;
  lane: TaskLane;
  priority?: TaskPriority;
  idempotency_key?: string | null;
  /** Who is opening the task, e.g. `bot:grok`. */
  actor: string;
}

export interface CreateTaskResult {
  task: TaskView;
  task_id: string;
  issue_url: string;
  /** False when the idempotency key matched an earlier call. */
  created: boolean;
  events: EventRow[];
}

export class TaskCreateError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 503 = 400) {
    super(message);
    this.name = "TaskCreateError";
  }
}

export const taskMarker = (key: string): string => `<!-- relay:task key=${key} -->`;

/**
 * The label that names an issue's project when the repository is shared by several (a productions repo: one GitHub
 * repo for issue tracking, one relay project per production). `openTask` adds it only on a shared repo, so a code
 * repo's issues stay as they were; the GitHub webhook reads it when no task row names the project.
 */
export const productionLabel = (slug: string): string => `production:${slug}`;
/** The slug a `production:<slug>` label names, or null for any other label. */
export function productionOf(label: string | null | undefined): string | null {
  const m = /^production:([\w.-]{1,100})$/.exec(label ?? "");
  return m?.[1] ?? null;
}

/** Validate the input the way every surface should; returns the problem or undefined. */
export function validateTaskInput(i: Partial<CreateTaskInput>): string | undefined {
  if (!i.project?.trim()) return "project is required";
  if (!i.title?.trim()) return "title is required";
  if (i.title.length > 256) return "title must be at most 256 characters";
  if (!i.lane || !isTaskLane(i.lane)) return `lane must be one of ${TASK_LANES.join(", ")}`;
  if (i.priority !== undefined && !isTaskPriority(i.priority)) return `priority must be one of ${TASK_PRIORITIES.join(", ")}`;
  if (i.idempotency_key && i.idempotency_key.length > 200) return "idempotency_key must be at most 200 characters";
  return undefined;
}

export async function openTask(db: Db, github: GitHubClient | undefined, input: CreateTaskInput): Promise<CreateTaskResult> {
  const bad = validateTaskInput(input);
  if (bad) throw new TaskCreateError(bad);
  const project = await getProject(db, input.project);
  if (!project) throw new TaskCreateError(`No project with slug '${input.project}'.`, 404);
  if (!project.repo) throw new TaskCreateError(`Project '${input.project}' has no repository; run relay link in it, or relay project add ${input.project} --repo owner/name.`, 400);
  const key = input.idempotency_key?.trim() || null;
  if (key) {
    const existing = await findTaskByKey(db, key);
    if (existing) {
      const view = await taskView(db, existing);
      return { task: view, task_id: view.id, issue_url: view.issue_url, created: false, events: [] };
    }
  }
  if (!github) throw new TaskCreateError("No GitHub credential: set GITHUB_TOKEN (web) or log in with gh (CLI).", 503);
  const marker = taskMarker(key ?? ulid());
  const body = `${(input.body ?? "").trim()}\n\n${marker}\n`.replace(/^\n+/, "");
  // on a repo several projects share (a productions repo), the issue says which project it belongs to
  const shared = (await projectsOnRepo(db, project.repo)).length > 1;
  const labels = [`agent:${input.lane}`, ...(input.priority ? [`priority:${input.priority}`] : []), ...(shared ? [productionLabel(project.slug)] : [])];
  const issue = await github.createIssue(project.repo, { title: input.title.trim(), body, labels });
  // Some installations ignore labels on create (no triage permission for the token); apply them explicitly then.
  const missing = labels.filter((l) => !issue.labels.includes(l));
  if (missing.length) await github.addLabels(project.repo, issue.number, missing).catch(() => {});
  const { task, created } = await createTask(db, { project: project.slug, repo: project.repo, issue: issue.number, idempotencyKey: key, createdBy: input.actor, lane: input.lane, title: input.title.trim() });
  const events: EventRow[] = [];
  const base = { actor: input.actor, project: project.slug, repo: project.repo, issue: issue.number, lane: input.lane, url: issue.html_url };
  const opened = await writeEvent(db, { ...base, kind: "issue.opened", summary: input.title.trim(), payload: { labels, via: "relay_task_create" }, dedupe_key: `task:${task.id}:opened` });
  if (opened) events.push(opened);
  const createdEv = await writeEvent(db, { ...base, kind: "task.created", summary: `${task.id}: ${input.title.trim()}`, payload: { task_id: task.id, lane: input.lane, priority: input.priority ?? null, idempotency_key: key }, dedupe_key: `task:${task.id}:created` });
  if (createdEv) events.push(createdEv);
  // the gate's pre-check: an obviously bad text is held here, before a worker spends a claim on it (gate.ts)
  const hits = precheckTask(`${input.title}\n\n${input.body ?? ""}`);
  if (hits.length) {
    const held = await writeEvent(db, heldEvent({ ...task, lane: input.lane }, "bot:relay", { score: 1, reasons: hits.map((h) => `pre-check: ${h}`), grader: "precheck", model: null }, { payload: { opened_by: input.actor }, dedupe_key: `task:${task.id}:held:create` }));
    if (held) events.push(held);
  }
  const view = await taskView(db, task);
  return { task: view, task_id: view.id, issue_url: issue.html_url || view.issue_url, created, events };
}
