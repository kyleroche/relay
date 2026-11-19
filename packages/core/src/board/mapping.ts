/**
 * How relay's vocabulary sits on a Vercel Board (docs/WORKERS.md, "The board"). Pure: no I/O, no handle.
 *
 *   channels   work/<project>   the one queue of a project: every thread in it is a task
 *              relay/workers    one thread per worker machine
 *
 * The queue is `work/<project>`, not `<project>/work`, because a claim names one subtree: `work/` is every project's
 * queue in one request, and Vercel's board refuses a subtree of more than 50 channels, so a project costs one.
 *
 *   labels     lane=<lane>    who may run it: a lane a worker serves, or `any` for the code lanes. It is the claim's filter.
 *              model=<id>     the model the lane is asked for (the lane's default without it)
 *              relay=<kind>   on a reply relay wrote: log, result, usage, brief, note, asset
 *
 * Labels only steer and describe. Anyone who may label in a channel can set them, so nothing that decides where a
 * worker clones, what it pushes or what gets merged is a label: that is in blocks (board/schemas.ts).
 *
 *   states     the board keeps `board.task`; a hold says why in its `kind`. `relayState` folds the two into the
 *              one word relay shows.
 */
import { createHash } from "node:crypto";
import type { MessageView, TaskView } from "@vercel/board";

export const WORK_ROOT = "work";
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

/** The project a queue belongs to; undefined for any other channel. */
export function projectOfChannel(channel: string): string | undefined {
  const m = /^work\/([^/]+)$/.exec(channel);
  return m && PROJECT_SLUG.test(m[1]!) ? m[1] : undefined;
}

export const LABEL = {
  lane: "lane",
  model: "model",
  /** On a reply: which of relay's own messages it is (`RELAY_MESSAGE`). */
  relay: "relay",
} as const;

export { ANY_LANE } from "../tasks/lanes.ts";

/** What a reply of relay's own is, in its `relay` label. Anything without the label is a person's (or another agent's) words. */
export const RELAY_MESSAGE = { log: "log", result: "result", usage: "usage", brief: "brief", note: "note", asset: "asset" } as const;

/** Why a task is held, in the hold's `kind`. */
export const HOLD = {
  /** The pull request (or the outputs) is there: a person approves or sends it back. The reason is the pull request's URL. */
  review: "awaiting_review",
  /** The injection gate flagged the text (tasks/gate.ts). */
  gate: "gate",
  /** The pull request is up and an after-pr step (eval) is looking at it before a person is asked. The reason is `evalHoldReason`. */
  eval: "awaiting_eval",
} as const;

/** The reason of an eval hold: the step, the lane it runs on, its task, and the pull request it looks at. */
export const evalHoldReason = (h: { step: string; lane: string; task: string; pr?: string }): string => `${h.step} on the ${h.lane} lane: task ${h.task}${h.pr ? ` on ${h.pr}` : ""}`;
export function parseEvalHold(reason: string | undefined): { step: string; lane: string; task: string; pr?: string } | undefined {
  const m = /^(\S+) on the (\S+) lane: task (\S+)(?: on (\S+))?$/.exec((reason ?? "").trim());
  return m ? { step: m[1]!, lane: m[2]!, task: m[3]!, ...(m[4] ? { pr: m[4] } : {}) } : undefined;
}

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
/** Whether a branch is one a lane pushed for this task. A pull request is this task's only when its head is. */
export const isBranchOf = (branch: string, id: string): boolean => /^relay\/[a-z][a-z0-9-]{0,31}-[0-9a-f]{8}$/.test(branch) && branch.endsWith(`-${taskRef(id)}`);

/** A board message holds 10,000 characters; a task's text is cut to this and the rest goes in an attachment. */
export const TEXT_MAX = 10_000;

/** The words of a task's root: the title as a heading, then the body. `openTask` appends the routing block. */
export function taskText(title: string, body: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  const b = body.trim();
  return b ? `# ${t}\n\n${b}` : `# ${t}`;
}

/** The title and body of a task's words, however they were written: a `# heading` first line, or just a first line. */
export function splitTaskText(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: "", body: "" };
  const title = lines[first]!.trim().replace(/^#{1,6}\s+/, "").slice(0, 200);
  return { title, body: lines.slice(first + 1).join("\n").trim() };
}

/** `owner/name#n`, as an issue is named. */
export function parseRef(v: string | undefined): { repo: string; number: number } | undefined {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(v ?? "");
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}

/** The pull request a GitHub URL names: `https://github.com/<owner>/<name>/pull/<n>`, and nothing else. */
export function parsePullUrl(url: string | undefined): { repo: string; number: number; url: string } | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec((url ?? "").trim());
  return m ? { repo: m[1]!, number: Number(m[2]), url: m[0] } : undefined;
}

/** A branch name safe to hand to git as an argument: no leading dash, no `..`, nothing a shell or a refspec reads specially. */
export const isBranchName = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(s) && !s.includes("..") && !s.includes("//") && !/[./]$/.test(s) && !s.endsWith(".lock");

/**
 * Whether a caller may do something in a channel, from the board's own answer about them (`me().can`: a map from
 * channel pattern to permissions). The most specific pattern decides: the channel itself, then the longest subtree,
 * then `*`.
 */
export function mayIn(can: Record<string, readonly string[]> | undefined, channel: string, permission: string): boolean {
  const patterns = Object.keys(can ?? {});
  const subtree = patterns.filter((p) => p.endsWith("/") && channel.startsWith(p)).sort((a, z) => z.length - a.length)[0];
  const decides = patterns.includes(channel) ? channel : (subtree ?? (patterns.includes("*") ? "*" : undefined));
  return decides !== undefined && can![decides]!.includes(permission);
}

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
