/**
 * What the site does to a task for whoever asked: the board's own task functions (packages/core/src/board/tasks.ts,
 * the ones the CLI calls), made as that person's or bot's profile so the board shows who it was. The API routes and
 * the pages' server actions both go through here, so a decision is the same wherever it was made.
 *
 * One rule is the site's own, because only the site knows a caller is a bot with a token: a bot never releases a task
 * it opened, and needs `tokens:write` to release any. It is judged from who the board says wrote the task, never from
 * a label or a name in the text. The MCP tool applies the same rule (packages/mcp/src/server.ts).
 */
import { board, isLaneName, laneNameProblem, repo, type Db, type GitHubClient } from "@relay/core";
import { actorBoard } from "./board.ts";

/** Who asked: `human:<login>` for a signed-in person, `bot:<token name>` for a token, with the scopes a token carries. */
export interface Asker {
  actor: string;
  scopes?: readonly string[];
}

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

const isBot = (asker: Asker): boolean => !asker.actor.startsWith("human:");
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Open a task from a request body: `{ project, title, body?, lane, model?, needs?, base?, idempotency_key? }`. The
 * repository is the project's registration, never the caller's word. `created` is false when the same caller's
 * idempotency key already made the task.
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

  const as = actorBoard(session, asker.actor);
  const key = text(body.idempotency_key);
  // a key is the caller's own: the same key from the same profile is the task its first call made
  const earlier = key ? await as.posted(key).catch(() => undefined) : undefined;
  if (earlier?.task) return { task: board.toTask(earlier), created: false };
  const model = text(body.model);
  const base = text(body.base);
  const task = await board.openServedTask(as, {
    project: row.slug,
    repo: row.repo,
    title,
    body: typeof body.body === "string" ? body.body : "",
    lane,
    ...(model ? { model } : {}),
    ...(needs.length ? { needs: needs.map((n) => String(n).trim()) } : {}),
    ...(base ? { base } : {}),
    ...(key ? { idempotencyKey: key } : {}),
  });
  return { task, created: true };
}

/** Approve a task in review: merge its pull request (or accept its outputs) and complete it. */
export function approveFor(session: board.BoardSession, github: GitHubClient | undefined, asker: Asker, id: string): Promise<board.ApproveResult> {
  return board.approveTask(actorBoard(session, asker.actor), github, id, { by: asker.actor });
}

export function requestChangesFor(session: board.BoardSession, github: GitHubClient | undefined, asker: Asker, id: string, note: string): Promise<board.BoardTask> {
  return board.requestChanges(actorBoard(session, asker.actor), github, id, note);
}

/** Lift the injection gate's hold for the text as it stands. */
export async function releaseFor(session: board.BoardSession, asker: Asker, id: string): Promise<board.BoardTask> {
  if (isBot(asker)) {
    if (asker.scopes && !asker.scopes.includes("tokens:write")) throw new TaskRefusal(`${asker.actor} cannot release ${id}: its token lacks tokens:write. A signed-in person, or a bot whose token holds tokens:write and that did not open the task, decides.`, 403);
    // the text a bot wrote is not the bot's to call safe
    const { thread } = await board.getTask(session.board, id);
    if (board.writtenAs(thread.message, asker.actor)) throw new TaskRefusal(`${asker.actor} opened ${id} and cannot release it. A person, or another bot with tokens:write, reads the text and decides.`, 403);
  }
  return board.releaseTask(actorBoard(session, asker.actor), id);
}

/** Back to the queue, optionally on another lane or model (`model: null` goes back to the lane's default). */
export function requeueFor(session: board.BoardSession, asker: Asker, id: string, opts: board.RequeueOptions): Promise<board.BoardTask> {
  return board.requeueTask(actorBoard(session, asker.actor), id, opts);
}

export function closeFor(session: board.BoardSession, github: GitHubClient | undefined, asker: Asker, id: string, reason: string | undefined): Promise<board.CloseResult> {
  return board.closeTask(actorBoard(session, asker.actor), github, id, { ...(reason ? { reason } : {}) });
}
