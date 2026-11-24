/**
 * The structured data relay posts on the board, as registered schemas (`createSchema` is idempotent: the same
 * definition again changes nothing, and a version never changes, so a new shape is a new version). A message that
 * carries one is a fenced block the board checked when it was written; readers take `message.blocks`, never the text.
 *
 *   relay-task@1     in a task's own text: where the work happens (repo, base, issue) and, for a step's task, what it looks at
 *   relay-run@1      a run's outcome, in the runner's reply: the branch, the pull request, the eval task it opened
 *   relay-eval@1     an eval's verdict, in the reply that carries its findings to the work's thread
 *   relay-release@1  a person's release of the injection gate's hold, for exactly the text they read
 *   relay-grant@1    a person's grant to one task: a capability set of its project's profile, or a spending cap for
 *                    a paid sandbox run, for exactly the task text they read
 *   relay-usage@1    one model call's cost: what a lane, the gate or a media model used (the ledger's row)
 *   relay-worker@1   a worker machine: its lanes, its labels and the plan meters its logins report
 *   relay-asset@1    one output file of the nodes lane, attached to the same message
 *
 * These carry what relay acts on, and a label never does, because of who can write each. Anyone who may label in a
 * channel can set any label. A task's text is its owner's (the board holds a task whose root someone else edits), and
 * a reply's author is verified by the board, so a block is trusted by where it is and who wrote it (`trustedBlocks`).
 */
import { block, BoardError, type Board, type MessageView } from "@vercel/board";
import type { MeterReading } from "../meters.ts";

const num = { type: "number", minimum: 0 } as const;
const str = (max: number) => ({ type: "string", maxLength: max }) as const;

export const TASK_SCHEMA = "relay-task@1";
export const RUN_SCHEMA = "relay-run@1";
export const EVAL_SCHEMA = "relay-eval@1";
export const RELEASE_SCHEMA = "relay-release@1";
export const GRANT_SCHEMA = "relay-grant@1";
export const USAGE_SCHEMA = "relay-usage@1";
export const WORKER_SCHEMA = "relay-worker@1";
export const ASSET_SCHEMA = "relay-asset@1";

/** What routes a task, written once by whoever opens it. */
export interface TaskBlock {
  /** `owner/name` of the repository the work happens in. */
  repo?: string;
  /** The branch to start from instead of the repository's default one. */
  base?: string;
  /** `owner/name#n` of the GitHub issue the task answers. */
  issue?: string;
  /** A step's own task: the step it runs, the task whose work it looks at, and that work's branch. */
  step?: string;
  evaluates?: string;
  branch?: string;
}

/** How a run ended, for the next run and for the commands that act on the task. */
export interface RunBlock {
  outcome: string;
  lane: string;
  worker: string;
  branch?: string;
  pr?: { repo: string; number: number; url: string };
  /** The task an after-pr step was opened as, when the work waits for it. */
  eval_task?: string;
}

export interface EvalBlock {
  step: string;
  /** The step's own task. */
  task: string;
  lane: string;
  /** The verdict line, or why the step could not run. */
  verdict: string;
  /** False when the step could not run: there are no findings to answer. */
  ran: boolean;
}

export interface ReleaseBlock {
  /** The digest of the text the gate held (`gateDigest`), so text added later is graded again. */
  digest: string;
}

/**
 * What a person lets one task use beyond the default of nothing: a capability set its project's profile defines
 * (names of environment variables and hosts), or a paid sandbox run up to a cap. It names the digest of the task's own
 * text, so it covers that text and not an edit made afterwards.
 */
export interface GrantBlock {
  set?: string;
  cloud_cap_usd?: number;
  digest: string;
}

/** What a run cost, as the ledger records it. `billing` keeps a subscription's run apart from one paid per token. */
export interface UsageBlock {
  /** run: the lane's work on the task; gate: the injection gate's grade; media: one output model of the nodes lane; step: a step's own model call (`step` names it). */
  kind: "run" | "gate" | "media" | "step";
  lane: string;
  tool: string;
  model: string | null;
  subscription: string | null;
  billing: "subscription" | "gateway";
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_equiv: number;
  duration_ms: number;
  worker: string;
  /** How the run ended, for a `run`: review, failed, held, settled. */
  outcome?: string;
  /** The step, for a `step` row. */
  step?: string;
}

export interface WorkerBlock {
  name: string;
  host: string;
  lanes: string[];
  labels: string[];
  version: string;
  /** The plan meters the machine's status line saved (`meters.ts`), as they were when this was posted. */
  meters: MeterReading[];
}

export interface AssetBlock {
  /** The end node and parameter of the workflow the file came from. */
  node: string;
  parameter: string;
  /** Which output of that parameter (1 for the first) and which run of the task (1 for the first). */
  index: number;
  version: number;
  workflow: string;
  mime: string;
  bytes: number;
  /** The board attachment on this message that is the file. */
  attachment: string;
  stage?: string;
  provider_job_id?: string;
}

const SCHEMAS: Array<{ name: string; version: number; description: string; schema: Record<string, unknown> }> = [
  {
    name: "relay-task",
    version: 1,
    description: "What routes a relay task, in the task's own text: the repository, the branch to start from, the issue it answers, and for a step's task what it looks at.",
    schema: { type: "object", properties: { repo: str(200), base: str(250), issue: str(220), step: str(48), evaluates: str(128), branch: str(250) } },
  },
  {
    name: "relay-run",
    version: 1,
    description: "How a relay run ended: its lane and worker, the branch and pull request it produced, the eval task it opened.",
    schema: {
      type: "object",
      required: ["outcome", "lane", "worker"],
      properties: {
        outcome: str(32),
        lane: str(64),
        worker: str(128),
        branch: str(250),
        pr: { type: "object", required: ["repo", "number", "url"], properties: { repo: str(200), number: { type: "integer", minimum: 1 }, url: str(400) } },
        eval_task: str(128),
      },
    },
  },
  {
    name: "relay-eval",
    version: 1,
    description: "The verdict of a step that judged a task's work, posted with its findings in that task's thread.",
    schema: { type: "object", required: ["step", "task", "lane", "verdict", "ran"], properties: { step: str(48), task: str(128), lane: str(64), verdict: str(900), ran: { type: "boolean" } } },
  },
  {
    name: "relay-release",
    version: 1,
    description: "A person's release of the injection gate's hold on a task, for the text with this digest.",
    schema: { type: "object", required: ["digest"], properties: { digest: str(64) } },
  },
  {
    name: "relay-grant",
    version: 1,
    description: "A person's grant to one relay task, for the task text with this digest: a capability set of the project's profile, or a cap in US dollars for a paid sandbox run.",
    schema: { type: "object", required: ["digest"], properties: { set: str(48), cloud_cap_usd: { type: "number", minimum: 0, maximum: 1000 }, digest: str(64) } },
  },
  {
    name: "relay-usage",
    version: 1,
    description: "What one model call cost: a lane's run on a task, the injection gate's grade, or one media output.",
    schema: {
      type: "object",
      required: ["kind", "lane", "tool", "billing", "tokens_in", "tokens_out", "cost_equiv", "duration_ms", "worker"],
      properties: {
        kind: { enum: ["run", "gate", "media", "step"] },
        lane: str(64),
        tool: str(64),
        model: { type: ["string", "null"], maxLength: 128 },
        subscription: { type: ["string", "null"], maxLength: 64 },
        billing: { enum: ["subscription", "gateway"] },
        tokens_in: num,
        tokens_out: num,
        cache_read: num,
        cache_write: num,
        cost_equiv: num,
        duration_ms: num,
        worker: str(128),
        outcome: str(32),
        step: str(48),
      },
    },
  },
  {
    name: "relay-worker",
    version: 1,
    description: "A relay worker machine: the lanes it serves, its labels, and the plan meters its logins report.",
    schema: {
      type: "object",
      required: ["name", "host", "lanes", "labels", "version", "meters"],
      properties: {
        name: str(128),
        host: str(256),
        lanes: { type: "array", items: str(64), maxItems: 32 },
        labels: { type: "array", items: str(128), maxItems: 64 },
        version: str(64),
        meters: {
          type: "array",
          maxItems: 16,
          items: {
            type: "object",
            required: ["subscription", "window", "used_percentage", "captured_at"],
            properties: { subscription: str(64), window: str(32), used_percentage: { type: "number" }, resets_at: { type: ["string", "null"] }, captured_at: str(40), source: str(64) },
          },
        },
      },
    },
  },
  {
    name: "relay-asset",
    version: 1,
    description: "One output file of a nodes-lane run, attached to the same message.",
    schema: {
      type: "object",
      required: ["node", "parameter", "index", "version", "workflow", "mime", "bytes", "attachment"],
      properties: {
        node: str(200),
        parameter: str(200),
        index: { type: "integer", minimum: 1 },
        version: { type: "integer", minimum: 1 },
        workflow: str(400),
        mime: str(128),
        bytes: num,
        attachment: str(128),
        stage: str(64),
        provider_job_id: str(200),
      },
    },
  },
];

/**
 * Make sure relay's schemas are on a board, and say whether they are. Registering takes `manage` everywhere, which a
 * person on the team has and a narrowed caller may not; a caller that is refused still works when someone who could
 * register them already did (a team's boards share one registry).
 */
export async function ensureSchemas(board: Board): Promise<boolean> {
  try {
    for (const s of SCHEMAS) await board.createSchema(s);
    return true;
  } catch (e) {
    if (!(e instanceof BoardError && (e.code === "forbidden" || e.status === 403))) throw e;
    const have = new Set((await board.schemas()).map((x) => `${x.name}@${x.version}`));
    return SCHEMAS.every((x) => have.has(`${x.name}@${x.version}`));
  }
}

export const taskBlockText = (t: TaskBlock): string => block(TASK_SCHEMA, { ...t });
export const runText = (r: RunBlock): string => block(RUN_SCHEMA, { ...r });
export const evalText = (e: EvalBlock): string => block(EVAL_SCHEMA, { ...e });
export const releaseText = (r: ReleaseBlock): string => block(RELEASE_SCHEMA, { ...r });
export const grantText = (g: GrantBlock): string => block(GRANT_SCHEMA, { ...g });
export const usageText = (u: UsageBlock): string => block(USAGE_SCHEMA, { ...u });
export const workerText = (w: WorkerBlock): string => block(WORKER_SCHEMA, { ...w });
export const assetText = (a: AssetBlock): string => block(ASSET_SCHEMA, { ...a });

/**
 * Words that are not relay's own, made safe to post: a fence that would be a data block becomes a plain json fence.
 * It follows the board's own parser: a line that opens a fence with backticks or tildes, any whitespace, then
 * `json#`. Who may write data is decided by who wrote the message (`isTrustedActor`), not by this; this keeps a
 * task's own text from carrying a second routing block, a worker's log from carrying one a model wrote, and a
 * malformed fence from making the board refuse the whole message.
 */
export const prose = (text: string): string => text.replace(/^( {0,3}(?:`{3,}|~{3,})[^\S\r\n]*)json#/gmu, "$1json ");

/** A message's text without its fenced blocks: what a person wrote around the data. */
export const withoutBlocks = (text: string): string => text.replace(/```json#[a-z0-9-]+@\d+\n[\s\S]*?\n```/g, "").replace(/\n{3,}/g, "\n\n").trim();

/**
 * The profiles relay's own code writes as: a worker's lanes (`relay-<worker>-<lane>`), a site's own writes
 * (`relay-site`) and its brief (`relay-brief`). A site writes for a person or a bot as a profile that never starts
 * this way (`actorProfile`), so what a caller's words say is never relay's data, whatever principal carried them.
 */
export const RELAY_PROFILE = "relay-";
/** A board kept in this process names its own client this, and a profile of it `board:client:<profile>` where a served board says `principal+profile`. */
const LOCAL_CLIENT = "board:client";

/**
 * Whether relay believes data from this actor: a trusted principal itself (a person at the CLI), or one of relay's
 * own profiles of it. Any other profile of a trusted principal is someone the site wrote for, and is not.
 */
export const isTrustedActor = (actor: string, trusted: readonly string[]): boolean =>
  trusted.some((t) => actor === t || actor.startsWith(`${t}+${RELAY_PROFILE}`) || (t === LOCAL_CLIENT && actor.startsWith(`${t}:${RELAY_PROFILE}`)));

/** The profile a hosted relay writes its own data as (board/site.ts). */
export const SITE_PROFILE = `${RELAY_PROFILE}site`;

/**
 * Whether a decision may be believed from this actor: what a task may reach or spend (a grant), or that the gate's
 * hold on it is lifted (a release). Only a trusted principal itself (a person at the CLI) or the site's own profile
 * of one (which writes for a signed-in person, board/desk.ts). A worker's profile is relay's too and reports what a
 * run did, but it never decides: a lane that got hold of its worker's board credential (a sandbox whose firewall
 * signs every request, cloud/plan.ts) could otherwise grant its own task a set or release its own text. An entry of
 * `trusted` that is itself a profile never decides either.
 */
export const isDecidingActor = (actor: string, trusted: readonly string[]): boolean =>
  trusted.some((t) => isPrincipal(t) && (actor === t || actor === `${t}+${SITE_PROFILE}` || (t === LOCAL_CLIENT && actor === `${t}:${SITE_PROFILE}`)));

/** A trusted entry that is a principal itself and not one of its profiles (a worker lists its own lane profiles as trusted, so it can read its other lanes' reports). */
const isPrincipal = (t: string): boolean => !t.includes("+") && !t.startsWith(`${LOCAL_CLIENT}:`);

/**
 * The blocks of one schema in a thread's replies that a trusted author wrote, oldest first, each with its reply's
 * place in the thread. A block anyone else posted is not relay's word, whatever it says. With `deciding`, only the
 * authors a decision is believed from (`isDecidingActor`).
 */
export function trustedBlocks<T>(replies: ReadonlyArray<Pick<MessageView, "blocks" | "by" | "deleted">>, schema: string, trusted: readonly string[], opts: { deciding?: boolean } = {}): Array<{ data: T; index: number }> {
  const believed = opts.deciding ? isDecidingActor : isTrustedActor;
  return replies.flatMap((m, index) => (m.deleted || !believed(m.by.actor, trusted) ? [] : blocksOf<T>(m, schema).map((data) => ({ data, index }))));
}

/** The blocks of one schema on a message, typed. */
export function blocksOf<T>(m: Pick<MessageView, "blocks">, schema: string): T[] {
  const [name, version] = schema.split("@");
  return (m.blocks ?? []).filter((b) => b.schema === name && String(b.version) === version).map((b) => b.data as T);
}
