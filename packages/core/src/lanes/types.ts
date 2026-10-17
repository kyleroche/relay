import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";

export type LaneName = "plan" | "review" | "code" | "3d" | "triage" | "digest" | "video" | "probe";
export type Subscription = "max" | "codex" | "grok" | "gateway";

export interface LaneRequest {
  lane: LaneName;
  /** Full brief; the lane passes it verbatim. Callers enforce caps before calling. */
  prompt: string;
  system?: string;
  cwd: string;
  /** Extra directories the tool may read. */
  addDirs?: string[];
  readOnly?: boolean;
  timeoutMs?: number;
  /** The environment the CLI process starts from (a worker passes `cleanEnv()`); the adapter still drops its vendor's API key. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Ledger attribution. */
  project?: string;
  task?: string;
  step?: number;
  /** JSON schema for structured output (Claude lane only). */
  jsonSchema?: Record<string, unknown>;
}

export interface LaneResult {
  ok: boolean;
  text: string;
  /** Parsed structured output when a schema was requested. */
  json?: unknown;
  model: string;
  subscription: Subscription;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costEquiv: number;
  durationMs: number;
  sessionId?: string;
  error?: string;
  raw?: unknown;
}

export class LaneError extends Error {
  constructor(message: string, readonly result?: Partial<LaneResult>) {
    super(message);
    this.name = "LaneError";
  }
}

/** Record a lane call as a `step.usage` event. Resolves once the row is written (or at once without a ledger). */
export async function recordLane(ledger: Ledger | undefined, req: LaneRequest, r: LaneResult, provider: string): Promise<void> {
  const e: LedgerEntry = {
    lane: req.lane,
    model: r.model,
    provider,
    subscription: r.subscription,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    cache_read: r.cacheRead,
    cache_write: r.cacheWrite,
    duration_ms: r.durationMs,
    note: r.ok ? "" : `error: ${(r.error ?? "").slice(0, 200)}`,
  };
  if (req.project) e.project = req.project;
  if (req.task) e.task = req.task;
  if (req.step !== undefined) e.step = req.step;
  if (r.costEquiv) e.cost_equiv = r.costEquiv;
  await ledger?.record(e);
}

/** One-at-a-time gate per subscription: personal-use logins must never run parallel farms. */
const locks = new Map<string, Promise<void>>();
export async function withSubscriptionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  locks.set(key, prev.then(() => mine));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}
