/**
 * What a GitHub delivery does on the board, besides its feed row (docs/WORKERS.md):
 *
 *   an issue opened with, or given, an `agent:<lane>` label   opens a task in the queue of the project registered
 *       for that repository, answering that issue. Only when the login behind the delivery may (`mayOpen`): anyone
 *       with triage on a repository can add a label, and a task spends a subscription on a worker.
 *   a pull request merged on GitHub                           completes the task in review that waits on it.
 *
 * Both are best effort for the route: the delivery is already in the feed, and a board that cannot be reached must
 * not make GitHub retry it.
 */
import { board, repo, type Db } from "@relay/core";
import { actorBoard } from "../board.ts";
import { laneOf, laneOfLabels } from "./github.ts";
import { productionFromLabels } from "./project.ts";

/** Who the site writes as when GitHub is what asked. */
export const INTAKE_ACTOR = "bot:github";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface IssueIntake {
  db: Db;
  session: board.BoardSession;
  /** Whether a GitHub login may open tasks from this repository (lib/webhooks/usage.ts `senderMayOpenTasks`). */
  mayOpen: (repo: string, login: string) => Promise<boolean>;
}

/**
 * The task an `issues` delivery opens, or undefined when it opens none (another action, no lane label, a sender who
 * may not, a repository no project is registered for). A lane that is neither built in nor served by a worker throws. The idempotency key is the issue, so the `opened` and
 * `labeled` deliveries of one new issue, and a redelivery, make one task. On a repository several projects share, a
 * `production:<slug>` label names the project.
 */
export async function openIssueTask(deps: IssueIntake, eventName: string, payload: Json): Promise<board.BoardTask | undefined> {
  if (eventName !== "issues") return undefined;
  const issue = obj(payload.issue);
  const repoName = str(obj(payload.repository)?.full_name);
  const number = issue?.number;
  if (!issue || !repoName || typeof number !== "number") return undefined;
  const lane = payload.action === "labeled" ? laneOf(str(obj(payload.label)?.name)) : payload.action === "opened" ? laneOfLabels(issue.labels) : null;
  if (!lane) return undefined;
  const login = str(obj(payload.sender)?.login) ?? "";
  if (!(await deps.mayOpen(repoName, login))) {
    console.warn(`[relay] ${repoName}#${number}: agent:${lane} by ${login || "an unknown sender"} opens no task; not in RELAY_ALLOWED_SENDERS`);
    return undefined;
  }
  const candidates = await repo.projectsOnRepo(deps.db, repoName);
  const named = productionFromLabels(issue.labels);
  const project = candidates.find((p) => p.slug === named) ?? candidates[0];
  if (!project) return undefined;
  const ref = `${repoName}#${number}`;
  // one profile for every delivery, so the issue's key finds its task whoever labelled it; who did is in the feed row.
  // A lane no worker serves is refused (the route logs it): a label is easy to mistype, and nobody would claim the task.
  return board.openServedTask(actorBoard(deps.session, INTAKE_ACTOR), { project: project.slug, repo: repoName, title: str(issue.title) ?? ref, body: str(issue.body) ?? "", lane, issue: ref, idempotencyKey: `issue:${ref}` });
}

/** The task a merged `pull_request` delivery completes, or undefined when none waits on that pull request. */
export async function settleMergedPull(session: board.BoardSession, eventName: string, payload: Json): Promise<board.BoardTask | undefined> {
  const pr = obj(payload.pull_request);
  if (eventName !== "pull_request" || payload.action !== "closed" || !pr || pr.merged !== true) return undefined;
  const url = str(pr.html_url);
  const head = str(obj(pr.head)?.ref);
  if (!url || !head) return undefined;
  return board.settleMerged(session.board, { url, head_ref: head, merge_sha: str(pr.merge_commit_sha) ?? null });
}
