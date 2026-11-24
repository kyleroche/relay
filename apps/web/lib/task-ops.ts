/**
 * What the site does to a task for whoever asked. The work and the rules are core's desk (packages/core/src/board/
 * desk.ts), which the MCP server uses too, so a decision is the same wherever it was asked for; this file turns a
 * request into a desk call. The API routes and the pages' server actions both go through here.
 */
import { board, isLaneName, laneNameProblem, repo, type Db, type GitHubClient } from "@relay/core";
import { taskBrief } from "./board-watch.ts";

export type Asker = board.Asker;

/** A refusal that names the request field it is about, for the problem document. */
export class TaskRefusal extends board.TaskError {
  constructor(
    message: string,
    status: number,
    readonly parameter?: string,
  ) {
    super(message, status);
  }
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Open a task from a request body: `{ project, title, body?, lane, model?, needs?, base?, plan?, idempotency_key? }`. The
 * repository is the project's registration, never the caller's word. `created` is false when the same caller's
 * idempotency key already made the task. The task's brief is in its thread before a worker can claim it.
 */
export async function openTaskFor(db: Db, session: board.BoardSession, asker: Asker, body: Record<string, unknown>): Promise<{ task: board.BoardTask; created: boolean }> {
  const project = text(body.project);
  const title = text(body.title);
  const lane = text(body.lane);
  if (!project) throw new TaskRefusal("project is required.", 400, "project");
  if (!title) throw new TaskRefusal("title is required.", 400, "title");
  if (!lane) throw new TaskRefusal("lane is required.", 400, "lane");
  if (!isLaneName(lane)) throw new TaskRefusal(`${laneNameProblem(lane)}.`, 400, "lane");
  if (body.body !== undefined && typeof body.body !== "string") throw new TaskRefusal("body must be a string.", 400, "body");
  const needs = body.needs ?? [];
  if (!Array.isArray(needs) || needs.some((n) => !text(n))) throw new TaskRefusal("needs must be an array of task IDs.", 400, "needs");
  const row = await repo.getProject(db, project);
  if (!row) throw new TaskRefusal(`No project '${project}'. Register it with relay link in its repository, or relay project add ${project} --repo owner/name.`, 404, "project");
  if (!row.repo) throw new TaskRefusal(`Project '${project}' has no repository to work in: relay project add ${project} --repo owner/name.`, 400, "project");
  const model = text(body.model);
  const base = text(body.base);
  const key = text(body.idempotency_key);
  return board.openFor(
    board.deskFor(session, asker),
    {
      project: row.slug,
      repo: row.repo,
      title,
      body: typeof body.body === "string" ? body.body : "",
      lane,
      ...(model ? { model } : {}),
      ...(needs.length ? { needs: needs.map((n) => String(n).trim()) } : {}),
      ...(base ? { base } : {}),
      ...(body.plan === true ? { step: "plan" } : {}),
      ...(key ? { idempotencyKey: key } : {}),
    },
    { brief: (task) => taskBrief(db, task) },
  );
}

export const approveFor = (session: board.BoardSession, github: GitHubClient | undefined, asker: Asker, id: string): Promise<board.ApproveResult> => board.approveFor(board.deskFor(session, asker), github, id);
export const requestChangesFor = (session: board.BoardSession, github: GitHubClient | undefined, asker: Asker, id: string, note: string): Promise<board.BoardTask> => board.requestChangesFor(board.deskFor(session, asker), github, id, note);
export const releaseFor = (session: board.BoardSession, asker: Asker, id: string): Promise<board.BoardTask> => board.releaseFor(board.deskFor(session, asker), id);
export const requeueFor = (session: board.BoardSession, asker: Asker, id: string, opts: board.RequeueOptions): Promise<board.BoardTask> => board.requeueFor(board.deskFor(session, asker), id, opts);
export const closeFor = (session: board.BoardSession, github: GitHubClient | undefined, asker: Asker, id: string, reason: string | undefined): Promise<board.CloseResult> => board.closeFor(board.deskFor(session, asker), github, id, reason);
