/** Types for loop.mjs, so a TypeScript test (packages/mcp/test) can drive the loop against the in-memory server. */

export interface LoopTiming {
  interval: number;
  maxInterval: number;
  heartbeat: number;
}
export const DEFAULTS: Readonly<LoopTiming>;

export interface ClaimIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  source: "github" | "relay";
}
export interface ResolvedInput {
  id: string;
  as: string | null;
  kind: string;
  mime: string;
  title: string;
  version: number;
  size: number;
  url: string;
}
export interface Job {
  lane?: string;
  inputs: ResolvedInput[];
  params: Record<string, unknown>;
  outputs: Array<{ name: string; format?: string }>;
}
/** What relay_work_claim returns (null when nothing is claimable). */
export interface Claim {
  task_id: string;
  project: string;
  repo: string;
  issue: ClaimIssue;
  lane: string;
  lease_until: string;
  review_note: string | null;
  brief: string;
  brief_omitted?: string;
  job: Job | null;
  job_error: string | null;
  next: string;
}

export interface UploadInput {
  filename: string;
  bytes: Uint8Array;
  contentType?: string;
  title?: string;
  description?: string;
  replaces?: string;
}
export interface AssetRowLike {
  id: string;
  title: string;
  kind: string;
  [k: string]: unknown;
}
export interface JobContext {
  log: (line: string) => void;
  heartbeat: () => Promise<unknown>;
  upload: (output: UploadInput) => Promise<AssetRowLike>;
}
export interface JobResult {
  summary?: string;
  assets?: string[];
  usage?: { cost_equiv?: number; model?: string; tokens_in?: number; tokens_out?: number; duration_ms?: number };
}
export type DoJob = (job: Claim, ctx: JobContext) => Promise<JobResult | void>;

export interface LoopDeps {
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  doJob: DoJob;
  name: string;
  lanes: string[];
  labels?: string[];
  host?: string;
  version?: string;
  put?: (url: string, bytes: Uint8Array, headers: Record<string, string>) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  timing?: Partial<LoopTiming>;
}

export interface RunOutcome {
  outcome: "finished" | "failed";
  state: string | null;
  assets: string[];
  error?: string;
}
export interface Tick {
  bell: { version: number; queued: number; ts: string };
  claimed: boolean;
  result: RunOutcome | null;
  interval: number;
}
export interface Loop {
  state: { workerId: string | null; version: number | null; interval: number; lastHeartbeat: number; busy: boolean };
  register(): Promise<{ worker_id: string; name: string; lanes: string[]; labels: string[]; registered: boolean }>;
  heartbeat(extra?: Record<string, unknown>): Promise<any>;
  tick(): Promise<Tick>;
  claimOnce(): Promise<RunOutcome | null>;
  runJob(claim: Claim): Promise<RunOutcome>;
  upload(claim: Claim, output: UploadInput): Promise<AssetRowLike>;
  run(opts?: { signal?: AbortSignal }): Promise<void>;
  shutdown(): Promise<void>;
}

export function nextInterval(current: number, activity: boolean, opts?: LoopTiming): number;
export function parseResult(result: unknown): any;
export class ToolError extends Error {}
export function fetchPut(url: string, bytes: Uint8Array, headers: Record<string, string>): Promise<void>;
export function createLoop(deps: LoopDeps): Loop;
