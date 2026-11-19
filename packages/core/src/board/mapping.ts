/**
 * How relay's vocabulary sits on a Vercel Board (docs/ARCHITECTURE.md, "The board"). Pure: no I/O, no handle.
 *
 *   channels   work/<project>        the one queue of a project: every thread in it is a task
 *              decisions/<project>   what waits for the owner (a plan's approval, a cloud run's spend)
 *              relay/workers         one thread per worker machine, relabelled as it lives
 *
 * The queue is `work/<project>`, not `<project>/work`, because a claim names one subtree: `work/` is every project's
 * queue in one request, and Vercel's board refuses a subtree of more than 50 channels, so a project costs one.
 *
 *   labels     lane=<lane>   who may run it: a lane this worker serves, or `any` for the code lanes
 *              model=<id>    the model the lane is asked to use (the lane's default without it)
 *              repo=<owner/name>, base=<branch>, issue=<owner/name#n>, priority=<p>
 *              pr=<owner/name#n>, branch=<name>   written by the runner once the pull request exists
 *              role=plan|review                   what kind of work the text describes
 *              step=<name>, evaluates=<task>      on a step's own task (steps/index.ts); eval=pending|answer|done on the task it looks at
 *              relay=<kind> on a reply            a message relay wrote: log, result, usage, brief, note, asset
 *
 *   states     the board keeps `board.task`; a hold says why in its `kind`. `relayState` folds the two into the
 *              one word relay shows.
 */
import { createHash } from "node:crypto";
import type { MessageView, TaskView } from "@vercel/board";

export const WORK_ROOT = "work";
export const DECISIONS_ROOT = "decisions";
export const WORKERS_CHANNEL = "relay/workers";

/** The subtree a claim names: every project's queue. */
export const WORK_SUBTREE = `${WORK_ROOT}/`;

/** A project's slug as relay registers it (`db/projects.ts`): also a valid channel segment. */
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function slug(project: string): string {
  if (!PROJECT_SLUG.test(project)) throw new Error(`'${project}' is not a project slug (lowercase letters, digits, '.', '_' and '-')`);
  return project;
}
export const workChannel = (project: string): string => `${WORK_ROOT}/${slug(project)}`;
export const decisionsChannel = (project: string): string => `${DECISIONS_ROOT}/${slug(project)}`;

/** The project a queue or decisions channel belongs to; undefined for any other channel. */
export function projectOfChannel(channel: string): string | undefined {
  const m = /^(?:work|decisions)\/([^/]+)$/.exec(channel);
  return m && PROJECT_SLUG.test(m[1]!) ? m[1] : undefined;
}

export const LABEL = {
  lane: "lane",
  model: "model",
  repo: "repo",
  base: "base",
  issue: "issue",
  priority: "priority",
  pr: "pr",
  branch: "branch",
  role: "role",
  /** On a step's own task: which step it runs, and the task whose work it looks at. */
  step: "step",
  evaluates: "evaluates",
  /** On a task whose work a step evaluates: `pending` while the step's task runs, `answer` once its findings are in the thread, `done` after the lane answered them. */
  eval: "eval",
  /** On a reply: which of relay's own messages it is (`RELAY_MESSAGE`). */
  relay: "relay",
} as const;

export { ANY_LANE } from "../tasks/lanes.ts";

/**
 * The labels that decide what a worker does with a task: where it clones, what it checks out, which lane and model
 * run it, which pull request settles it. On the board anyone who may label in a channel may set them, which is wider
 * than who may give a worker instructions, so a job checks who set them (`foreignLabelChange` in work/job.ts).
 */
export const ROUTING_LABELS: readonly string[] = ["lane", "model", "repo", "base", "issue", "pr", "branch", "step", "evaluates", "eval"];

/** Whether an actor is one of the trusted principals or a profile of one (`principal+profile`). */
export const isTrustedActor = (actor: string, trusted: readonly string[]): boolean => trusted.some((t) => actor === t || actor.startsWith(`${t}+`));

/** What a reply of relay's own is, in its `relay` label. Anything without the label is a person's (or another agent's) words. */
export const RELAY_MESSAGE = { log: "log", result: "result", usage: "usage", brief: "brief", note: "note", asset: "asset" } as const;
export type RelayMessageKind = (typeof RELAY_MESSAGE)[keyof typeof RELAY_MESSAGE];

/** Why a task is held, in the hold's `kind`. */
export const HOLD = {
  /** The pull request (or the asset) is there: a person approves or sends it back. */
  review: "awaiting_review",
  /** The injection gate flagged the text (tasks/gate.ts). */
  gate: "gate",
  /** A plan or a spend waits for the owner's yes. */
  approval: "awaiting_approval",
  /** The worker asked a question. */
  input: "needs_input",
  /** The pull request is up and an after-pr step (eval) is looking at it before a person is asked. */
  eval: "awaiting_eval",
  /** Someone the worker does not take work from changed a label that routes the task. */
  labels: "labels_changed",
} as const;

/** The board's own states for a task. */
export type BoardTaskState = TaskView["state"];

/**
 * The one word relay shows for a task:
 *   waiting   a task it needs has not completed            queued    ready for a worker
 *   running   a worker holds it                            review    held for a person's decision on a PR or an asset
 *   held      held by the injection gate                   blocked   held for any other reason (a question, an approval, an edit)
 *   done      completed                                    failed    a worker gave up; reopen retries it
 *   closed    called off by its owner
 */
export type RelayState = "waiting" | "queued" | "running" | "review" | "held" | "blocked" | "done" | "failed" | "closed";
export const RELAY_STATES: readonly RelayState[] = ["waiting", "queued", "running", "review", "held", "blocked", "done", "failed", "closed"];
export const OPEN_STATES: readonly RelayState[] = ["waiting", "queued", "running", "review", "held", "blocked", "failed"];

export function relayState(task: Pick<TaskView, "state" | "blocked">): RelayState {
  switch (task.state) {
    case "waiting":
      return "waiting";
    case "ready":
      return "queued";
    case "claimed":
      return "running";
    case "blocked":
      return task.blocked?.kind === HOLD.review ? "review" : task.blocked?.kind === HOLD.gate ? "held" : "blocked";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "canceled":
      return "closed";
  }
}

/** A short, stable name for a task where its ID cannot go as it is (a branch, a directory): eight hex characters of its hash. */
export const taskRef = (id: string): string => createHash("sha1").update(id).digest("hex").slice(0, 8);

/** The branch a lane pushes for a task. A re-run of the task replaces its own branch. */
export const branchFor = (lane: string, id: string): string => `relay/${lane}-${taskRef(id)}`;
/** Whether a name has the shape of a branch relay made. A label is anyone's to set, so a branch named in one is checked before it is fetched. */
export const isRelayBranch = (name: string): boolean => /^relay\/[a-z][a-z0-9-]{0,31}-[0-9a-f]{8}$/.test(name);

/** A board message holds 10,000 characters; a task's text is cut to this and the rest goes in an attachment. */
export const TEXT_MAX = 10_000;

/** The text of a task's root: the title as a heading, then the body. */
export function taskText(title: string, body: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  const b = body.trim();
  return b ? `# ${t}\n\n${b}` : `# ${t}`;
}

/** The title and body of a task's root, however it was written: a `# heading` first line, or just a first line. */
export function splitTaskText(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: "", body: "" };
  const title = lines[first]!.trim().replace(/^#{1,6}\s+/, "").slice(0, 200);
  return { title, body: lines.slice(first + 1).join("\n").trim() };
}

/** `owner/name#n` as a pull request or issue label carries it. */
export function parseRef(v: string | undefined): { repo: string; number: number } | undefined {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(v ?? "");
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}
export const formatRef = (repo: string, number: number): string => `${repo}#${number}`;

/** A label value holds 256 characters. */
export const LABEL_VALUE_MAX = 256;
export const labelValue = (v: string): string => v.replace(/\s+/g, " ").trim().slice(0, LABEL_VALUE_MAX);

/** The profile a worker writes as on a lane: `relay-<worker>-<lane>`, within the board's 32 characters (letters, digits, hyphens, a letter first). */
export function workerProfile(worker: string, lane: string): string {
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const tail = `-${clean(lane) || "lane"}`;
  const head = `relay-${clean(worker) || "worker"}`;
  const room = 32 - tail.length;
  // a long host keeps its start and a hash of the whole, so two long names never share a profile
  const fitted = head.length <= room ? head : `${head.slice(0, room - 5).replace(/-+$/, "")}-${taskRef(head).slice(0, 4)}`;
  return `${fitted}${tail}`;
}

/** The labels of a message that relay reads, with the board's own (`board.*`) left out. */
export function relayLabels(m: Pick<MessageView, "labels">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.labels ?? {})) if (!k.startsWith("board.")) out[k] = v;
  return out;
}
