/**
 * What a relay that answers for other people does to a task: the site's API, its pages' actions and the MCP server
 * all go through here, so a decision is the same wherever it was asked for. Underneath are the board's own task
 * functions (board/tasks.ts), the ones the CLI calls.
 *
 * A site is one deployment on the board whoever asked, so these are its own to get right:
 *
 *   two voices   a caller's words (a task's text, a review note) and their decisions go out as a profile named for
 *                them, which no worker believes as data. What relay itself says as data (a gate release, an eval that
 *                could not run) goes out as the site's own profile, after the site has checked who asked.
 *   two rules    a bot, which is a token rather than a signed-in person, never approves a task it opened and never
 *                releases a task whose text it wrote any part of: it would be deciding on its own work. Releasing
 *                also takes `tokens:write`. Both are judged from who the board says wrote a message.
 *   grants       what a task may reach or spend beyond the default of nothing (a capability set, a paid sandbox
 *                run) is a signed-in person's to give, never a token's.
 *   the brief    a task the site opens has its brief in the thread before any worker can claim it.
 *   ownership    the board lets a task's owner lift a hold, reopen and cancel it, and holds a profile to what that
 *                profile made. The site's deployment owns every task opened through it, so the task functions make
 *                those calls as the deployment itself (`asOwner`), after the rules above were checked here. A task
 *                opened from a machine is not the site's, and the refusal says where it is settled.
 *
 * Without an asker the caller is whoever holds the handle (a person at their own machine): one voice, no rules.
 */
import type { Board } from "@vercel/board";
import type { GitHubClient } from "../github/client.ts";
import type { BoardSession } from "./client.ts";
import { LABEL, RELAY_MESSAGE } from "./mapping.ts";
import { actorProfile, BRIEF_PROFILE, postBrief, SITE_PROFILE, writtenAs } from "./site.ts";
import { approveTask, closeTask, grantTask, releaseTask, requestChanges, requeueTask, TaskError, type ApproveResult, type BoardTask, type CloseResult, type OpenTaskInput, type RequeueOptions } from "./tasks.ts";
import { openServedTask } from "./workers.ts";

/** Who asked: `human:<login>` for a signed-in person, `bot:<token name>` for a token, with the scopes a token carries. */
export interface Asker {
  actor: string;
  scopes?: readonly string[];
}

export interface Desk {
  session: BoardSession;
  asker: Asker | undefined;
  /** The handle a caller's own words and decisions go out on. */
  words: Board;
  /** The handle relay's own data goes out on. */
  own: Board;
}

export function deskFor(session: BoardSession, asker?: Asker): Desk {
  return asker ? { session, asker, words: session.board.as(actorProfile(asker.actor)), own: session.board.as(SITE_PROFILE) } : { session, asker, words: session.board, own: session.board };
}

const isBot = (asker: Asker | undefined): asker is Asker => !!asker && !asker.actor.startsWith("human:");

/**
 * What to run while a new task is still out of every worker's reach so that its brief is in the thread first. A brief
 * that cannot be made or posted never stops the task from opening: the worker compiles its own then.
 */
export function briefBeforeReady(session: BoardSession, brief: (task: BoardTask) => Promise<string | undefined>): (task: BoardTask) => Promise<void> {
  return async (task) => {
    const text = await brief(task).catch(() => undefined);
    if (text?.trim()) await postBrief(session.board.as(BRIEF_PROFILE), task.id, text).catch(() => undefined);
  };
}

/**
 * Open a task on a lane somebody serves. `created` is false when the caller's idempotency key already made it.
 * `brief` compiles the task's brief, which is posted before the task is ready.
 */
export async function openFor(desk: Desk, input: OpenTaskInput, opts: { brief?: (task: BoardTask) => Promise<string | undefined> } = {}): Promise<{ task: BoardTask; created: boolean }> {
  return openServedTask(desk.words, input, opts.brief ? { beforeReady: briefBeforeReady(desk.session, opts.brief) } : {});
}

/**
 * Approving and closing end a task, and a token ends one only with `tasks:decide`. The API route and the MCP gate
 * check the scope before they get here; the desk checks it again, so a surface added later cannot forget to.
 */
function mayDecide(desk: Desk, what: "approve" | "close", id: string): void {
  const asker = desk.asker;
  if (isBot(asker) && asker.scopes && !asker.scopes.includes("tasks:decide")) throw new TaskError(`${asker.actor} cannot ${what} ${id}: its token lacks tasks:decide. A signed-in person, or a bot whose token holds that scope, decides.`, 403);
}

/** Approve a task in review: merge its pull request (or accept its outputs) and complete it. */
export async function approveFor(desk: Desk, github: GitHubClient | undefined, id: string): Promise<ApproveResult> {
  mayDecide(desk, "approve", id);
  if (isBot(desk.asker) && writtenAs((await desk.session.board.thread(id.trim())).message, desk.asker.actor)) {
    throw new TaskError(`${desk.asker.actor} opened ${id} and cannot approve it: a bot never approves its own work. A signed-in person, or another bot with tasks:decide, decides.`, 403);
  }
  return approveTask(desk.words, github, id, { ...(desk.asker ? { by: desk.asker.actor } : {}) });
}

export function requestChangesFor(desk: Desk, github: GitHubClient | undefined, id: string, note: string): Promise<BoardTask> {
  return requestChanges(desk.words, github, id, note);
}

/** Lift the injection gate's hold for the text as it stands. */
export async function releaseFor(desk: Desk, id: string): Promise<BoardTask> {
  const asker = desk.asker;
  if (isBot(asker)) {
    if (asker.scopes && !asker.scopes.includes("tokens:write")) throw new TaskError(`${asker.actor} cannot release ${id}: its token lacks tokens:write. A signed-in person, or a bot whose token holds tokens:write and wrote none of the task's text, decides.`, 403);
    // the gate grades the task's own text and every note in its thread: none of it is the bot's to call safe if the bot wrote it
    const thread = await desk.session.board.thread(id.trim());
    const graded = [thread.message, ...thread.replies.filter((m) => !m.deleted && (m.labels?.[LABEL.relay] === undefined || m.labels[LABEL.relay] === RELAY_MESSAGE.note))];
    if (graded.some((m) => writtenAs(m, asker.actor))) throw new TaskError(`${asker.actor} wrote part of the text of ${id} and cannot release it. A person, or another bot with tokens:write, reads the text and decides.`, 403);
  }
  return releaseTask(desk.words, id, { own: desk.own, ...(asker ? { by: asker.actor } : {}) });
}

/**
 * Grant a task a capability set of its project's profile, or a paid sandbox run up to a cap. Only a signed-in person:
 * a token never decides what a task may reach or what it may spend.
 */
export async function grantFor(desk: Desk, id: string, grant: { set?: string; cloudCapUsd?: number }): Promise<BoardTask> {
  const asker = desk.asker;
  if (asker && !asker.actor.startsWith("human:")) throw new TaskError(`${asker.actor} cannot grant ${id} anything: a grant is a signed-in person's to give.`, 403);
  return grantTask(desk.words, id, grant, { own: desk.own, ...(asker ? { by: asker.actor } : {}) });
}

/** Back to the queue, optionally on another lane or model (`model: null` goes back to the lane's default). */
export function requeueFor(desk: Desk, id: string, opts: RequeueOptions = {}): Promise<BoardTask> {
  return requeueTask(desk.words, id, opts);
}

export async function closeFor(desk: Desk, github: GitHubClient | undefined, id: string, reason?: string): Promise<CloseResult> {
  mayDecide(desk, "close", id);
  return closeTask(desk.words, github, id, { ...(reason ? { reason } : {}), own: desk.own });
}
