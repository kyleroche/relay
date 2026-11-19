/**
 * The structured data relay posts on the board, as registered schemas (`createSchema` is idempotent: the same
 * definition again changes nothing, and a version never changes, so a new shape is a new version). A message that
 * carries one is a fenced block the board checked when it was written; readers take `message.blocks`, never the text.
 *
 *   relay-usage@1    one model call's cost: what a lane, the gate or a media model used (the ledger's row)
 *   relay-worker@1   a worker machine: its lanes, its labels and the plan meters its logins report
 *   relay-asset@1    one output file of the nodes lane, attached to the same message
 */
import { block, BoardError, type Board, type MessageView } from "@vercel/board";
import type { MeterReading } from "../meters.ts";

const num = { type: "number", minimum: 0 } as const;
const str = (max: number) => ({ type: "string", maxLength: max }) as const;

export const USAGE_SCHEMA = "relay-usage@1";
export const WORKER_SCHEMA = "relay-worker@1";
export const ASSET_SCHEMA = "relay-asset@1";

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
 * Register relay's schemas on a board. Registering takes `manage` everywhere, which a person on the team has and a
 * narrowed worker may not: a `forbidden` answer is returned as `false` so the caller can say who should run setup,
 * and the schemas someone else registered still serve.
 */
export async function ensureSchemas(board: Board): Promise<boolean> {
  try {
    for (const s of SCHEMAS) await board.createSchema(s);
    return true;
  } catch (e) {
    if (e instanceof BoardError && (e.code === "forbidden" || e.status === 403)) return false;
    throw e;
  }
}

export const usageText = (u: UsageBlock): string => block(USAGE_SCHEMA, { ...u });
export const workerText = (w: WorkerBlock): string => block(WORKER_SCHEMA, { ...w });
export const assetText = (a: AssetBlock): string => block(ASSET_SCHEMA, { ...a });

/** The blocks of one schema on a message, typed. */
export function blocksOf<T>(m: Pick<MessageView, "blocks">, schema: string): T[] {
  const [name, version] = schema.split("@");
  return (m.blocks ?? []).filter((b) => b.schema === name && String(b.version) === version).map((b) => b.data as T);
}
