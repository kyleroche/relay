/**
 * Shared bits of the task surfaces: state copy and tones, the board's columns, which decisions a state allows, the
 * page path, the prompt that drives a review from chat. A task is a thread on the team's Vercel Board; its state is
 * one of core's `RelayState` words (packages/core/src/board/mapping.ts). Pure, no I/O.
 */
import type { board } from "@relay/core";
import { HOLD, parseEvalHold, REPORT_REASON } from "@relay/core/board/mapping.ts";
import type { StatusTone } from "@/components/ui/status-badge";
import type { ReviewKind } from "./review.ts";
import { SITE_URL } from "./site.ts";

export { taskPagePath } from "./task-path.ts";
export type { ReviewKind } from "./review.ts";

export type RelayState = board.RelayState;
type Task = board.BoardTask;

export const STATE_HINT: Record<RelayState, string> = {
  waiting: "A task it needs has not completed; it joins the queue by itself when that one does.",
  queued: "Ready for a worker that serves its lane (new, sent back with a note, or requeued).",
  running: "A worker holds it and the lane is working in a fresh clone; the claim is a lease the job keeps renewing.",
  review: "The pull request (or the outputs, a report, a proposed plan) is there. Look at it, then approve, or send it back with a note.",
  held: "The injection gate flagged the text as instructions aimed at the agent; no worker runs it until someone reads it and releases it.",
  blocked: "Held for another reason: a step (an eval) is looking at the work, or the board holds a task whose text someone else edited.",
  done: "Merged (by an approval here or on GitHub), or its outputs were approved.",
  failed: "A worker gave up; the reason says why. Requeue retries it.",
  closed: "Called off without a merge.",
};

export const STATE_TONE: Record<RelayState, StatusTone> = {
  waiting: "muted",
  queued: "muted",
  running: "primary",
  review: "warn",
  held: "warn",
  blocked: "muted",
  done: "ok",
  failed: "bad",
  closed: "muted",
};

/** The tone as a text color class, for the one place a state word is colored outside a badge (the board's column headers). */
export const TONE_TEXT: Record<StatusTone, string> = {
  muted: "text-muted-foreground",
  primary: "text-primary",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

export type ColumnKey = "held" | "queued" | "running" | "review" | "failed" | "done";

export interface Column {
  key: ColumnKey;
  label: string;
  tone: StatusTone;
  hint: string;
  /** Drawn even when empty. */
  always: boolean;
  cap: number;
}

/**
 * The board's columns, left to right. Held comes first because those wait for a person to read them; it and Failed
 * appear only when they hold something.
 */
export const COLUMNS: readonly Column[] = [
  { key: "held", label: "Held", tone: "warn", hint: `${STATE_HINT.held} A task the board holds for any other reason is here too, with the reason.`, always: false, cap: 25 },
  { key: "queued", label: "Queue", tone: "muted", hint: `${STATE_HINT.queued} A task waiting for another one is here too.`, always: true, cap: 25 },
  { key: "running", label: "Running", tone: "primary", hint: STATE_HINT.running, always: true, cap: 25 },
  { key: "review", label: "Review", tone: "warn", hint: `${STATE_HINT.review} Work an eval step is still looking at is here too, marked with what it waits on.`, always: true, cap: 25 },
  { key: "failed", label: "Failed", tone: "bad", hint: STATE_HINT.failed, always: false, cap: 10 },
  { key: "done", label: "Done", tone: "ok", hint: `${STATE_HINT.done} Closed tasks are here too.`, always: true, cap: 10 },
];

/** What an eval hold says it waits on (the step, its lane, its own task), or undefined for any other hold. */
export const evalWait = (t: Pick<Task, "hold">): ReturnType<typeof parseEvalHold> => (t.hold?.kind === HOLD.eval ? parseEvalHold(t.hold.reason) : undefined);

/** The column a task's card is in: work an eval is looking at sits in Review, since a review is what follows. */
export function columnOf(t: Pick<Task, "state" | "hold">): ColumnKey {
  switch (t.state) {
    case "waiting":
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "review":
      return "review";
    case "blocked":
      return t.hold?.kind === HOLD.eval ? "review" : "held";
    case "held":
      return "held";
    case "failed":
      return "failed";
    case "done":
    case "closed":
      return "done";
  }
}

export interface TaskDecisions {
  /** Approve and request changes: a task in review. */
  review: boolean;
  /** Lift the injection gate's hold. */
  release: boolean;
  /** Back to the queue: anything but a finished or a running task (a running one belongs to its worker until the lease ends). */
  requeue: boolean;
  /** Finish without a merge: anything not finished. */
  close: boolean;
}

/**
 * What a task in review asks a person to approve, as core's `approveTask` reads the hold: a pull request to merge, a
 * plan whose tasks an approval opens, a report to read, or outputs attached to the thread.
 */
export function reviewKind(t: Pick<Task, "pr" | "hold">): ReviewKind {
  if (t.hold?.kind === HOLD.plan) return "plan";
  if (t.pr) return "pr";
  return t.hold?.kind === HOLD.review && t.hold.reason === REPORT_REASON ? "report" : "outputs";
}

/**
 * The tasks an approved plan opened, from the line core leaves in the planning task's thread ("Plan approved by …
 * Opened 2 tasks: api (790.812), ui (790.813)."). `by` is who the board says wrote the reply, as the feed names
 * actors: the line counts only from a person or a bot, the two an approval can come from, so an agent's own profile
 * posting the same words makes no links. Links only: nothing is decided from this.
 */
export function planOpened(replies: ReadonlyArray<{ text: string; by: string; log: boolean }>): Array<{ key: string; id: string }> {
  for (const r of [...replies].reverse()) {
    if (!r.log || !/^(human|bot):/.test(r.by)) continue;
    const m = /^Plan approved(?: by [^\n]*?)?\. Opened \d+ tasks?: (.+)\.$/.exec(r.text.trim());
    if (!m) continue;
    return [...m[1]!.matchAll(/([a-z0-9][a-z0-9-]{0,39}) \(([^\s()]+)\)/g)].map((x) => ({ key: x[1]!, id: x[2]! }));
  }
  return [];
}

/** Which decisions a task's state allows, as core's task functions accept them (packages/core/src/board/tasks.ts). */
export function decisionsFor(state: RelayState): TaskDecisions {
  const finished = state === "done" || state === "closed";
  return { review: state === "review", release: state === "held", requeue: !finished && state !== "running", close: !finished };
}

/**
 * The profile a claim was made as (`relay-<worker>-<lane>` for a worker's lane): the part after `+` of an actor on
 * Vercel's board, the whole name of a local board's in-process client.
 */
export function claimProfile(actor: string): string {
  const plus = actor.lastIndexOf("+");
  if (plus >= 0) return actor.slice(plus + 1);
  return /^board:client:(.+)$/.exec(actor)?.[1] ?? actor;
}

/** The prompt to hand an agent that should drive the review from chat (DESIGN.md, item 7: self-serve first). */
export const REVIEW_AGENT_PROMPT = `Connect to the relay MCP server at ${SITE_URL}/mcp (scopes tasks:read tasks:write tasks:decide; approving takes tasks:decide). Call relay_task_list({state: "review"}) and, for each task, relay_task_get(task_id): tell me the title, the pull request and what the lane said. When I say "approve <task>" call relay_task_approve({id}); when I say "send back <task>: <note>" call relay_task_request_changes({id, note}). To tell me when new work is ready to look at, check relay_task_list({state: "review"}) again.`;
