import type { TaskState, TaskView } from "@relay/core";
import type { EventKind } from "./events.ts";

export type { TaskState, TaskView };

export interface TaskListOptions {
  project?: string;
  state?: TaskState;
  limit?: number;
}

export type ActorKind = "human" | "bot" | "runner" | "agent";
export type Subscription = "max" | "codex" | "grok" | "gateway";
export type Lane = "claude" | "codex" | "grok";

/** One row of the `events` table (see packages/core/src/db/schema.sql). */
export interface FeedEvent {
  id: number;
  ts: string;
  kind: EventKind;
  actor: string;
  project: string | null;
  repo: string | null;
  issue: number | null;
  pr: number | null;
  lane: Lane | null;
  model: string | null;
  subscription: Subscription | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_equiv: number;
  duration_ms: number | null;
  summary: string;
  url: string | null;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
}

/** What webhooks and lanes hand to writeEvent. Everything the schema defaults is optional. */
export type NewEvent = Partial<Omit<FeedEvent, "id" | "kind" | "actor" | "summary">> &
  Pick<FeedEvent, "kind" | "actor" | "summary">;

export interface FeedOptions {
  project?: string;
  kind?: EventKind | string;
  actor?: string;
  lane?: Lane | string;
  limit?: number;
  /** ISO timestamp; return events strictly older than this. */
  before?: string;
  /** ISO timestamp; return events strictly newer than this (live polling). */
  after?: string;
}

export interface ProjectSummary {
  slug: string;
  repo: string;
  stack: string | null;
  summary: string | null;
  lastActivity: string | null;
  openIssues: number;
  decisionsCount: number;
  digest: { digested: number; total: number };
  lanes: Lane[];
}

export interface Decision {
  id: number;
  project: string;
  text: string;
  source: string;
  source_ref: string | null;
  valid_from: string;
}

export type ModelStatus = "ready" | "stale" | "pending";

export interface ModelInfo {
  id: string;
  provider: string;
  lanes: string[];
  onboarded_at: string | null;
  guidance_count: number;
  skill_count: number;
  stale_days: number;
  status: ModelStatus;
}

export interface ProjectDetail extends ProjectSummary {
  decisions: Decision[];
  events: FeedEvent[];
  models: ModelInfo[];
  check_cmd: string | null;
}

export type UsageWindow = "5h" | "7d" | "30d";

export interface SubscriptionUsage {
  subscription: Subscription;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cost_equiv: number;
  avg_ctx: number;
}

/** A plan meter. percentUsed is null when the vendor exposes no meter for that window. */
/**
 * Where a plan meter's number came from: `vendor` is a reading Claude Code handed relay's status line on a worker
 * (lib/meters.ts), `manual` the RELAY_PLAN_METERS override, `demo` mock data, `none` no reading at all.
 */
export type PlanMeterSource = "vendor" | "manual" | "demo" | "none";

export interface PlanMeter {
  id: string;
  label: string;
  subscription: Subscription;
  percentUsed: number | null;
  resetsAt: string | null;
  resetsIn: string | null;
  source: PlanMeterSource;
  /** When the vendor reading was taken (ISO); null unless `source` is `vendor`. */
  capturedAt: string | null;
  /** The worker (machine) that reported the reading; null unless `source` is `vendor`. */
  worker: string | null;
  /** Human note for the unknown case, e.g. "Codex does not publish a weekly meter". */
  note?: string;
}

export interface UsageSummary {
  window: UsageWindow;
  since: string;
  subscriptions: SubscriptionUsage[];
  windows: PlanMeter[];
  /** Cost equivalent per day per subscription, oldest first. */
  daily: Array<{ day: string } & Partial<Record<Subscription, number>>>;
  /** Average input context (tokens_in + cache_read) per call per day, oldest first. */
  avgCtx: Array<{ day: string; avg_ctx: number; calls: number }>;
  /** Average input context per call across the window. */
  avgCtxWindow: number;
}

export type WorkerStatus = "online" | "idle" | "offline";

export interface Worker {
  name: string;
  host: string;
  labels: string[];
  lastSeen: string;
  /** From last_seen: online under 2 minutes, idle under an hour, offline beyond (or when the worker said so). */
  status: WorkerStatus;
  /** Offline for more than 7 days: folded away on the workers page and left out of the board's worker count until forgotten (docs/WORKERS.md, "Retiring a worker"). */
  retired: boolean;
  lanes: Lane[];
  /** relay CLI version the worker runs; "" when unknown. */
  version: string;
  runsToday: number;
  /** The poll interval (ms) the worker last reported; null for one that never said (an Actions runner, an older relay). */
  pollMs: number | null;
  current: { project: string; issue: number; startedAt: string; taskId?: string; leaseUntil?: string } | null;
}

export type AssetKind = "image" | "video" | "audio" | "pdf" | "html" | "file";
export type AssetStatus = "pending" | "approved" | "rejected" | "superseded" | "published";
export const ASSET_KINDS: AssetKind[] = ["image", "video", "audio", "pdf", "html", "file"];
export const ASSET_STATUSES: AssetStatus[] = ["pending", "approved", "rejected", "superseded", "published"];

/** One row of the `assets` table (docs/ASSETS.md) with short-lived view URLs resolved for this response. */
export interface Asset {
  id: string;
  project: string | null;
  issue: number | null;
  pr: number | null;
  title: string;
  description: string | null;
  kind: AssetKind;
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  version: number;
  parent_id: string | null;
  status: AssetStatus;
  created_by: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  public_url: string | null;
  expires_at: string | null;
  tags: string[];
  /** Signed view URL for the bytes (expires), or null when the store cannot serve them. */
  url: string | null;
  /** Signed URL for the thumbnail or poster, or null. */
  thumb_url: string | null;
  /** For kind=html: the URL of the bundle's index entry, served in a sandboxed iframe. */
  bundle_url: string | null;
}

export interface AssetVersion {
  id: string;
  version: number;
  status: AssetStatus;
  created_at: string;
  created_by: string;
  thumb_url: string | null;
}

export interface AssetDetail {
  asset: Asset;
  versions: AssetVersion[];
  /** The GitHub URL of the issue or PR the asset belongs to, when the project has a repo. */
  task_url: string | null;
}

export interface AssetListOptions {
  project?: string;
  status?: AssetStatus;
  kind?: AssetKind;
  issue?: number;
  pr?: number;
  limit?: number;
}

export interface AssetReview {
  decision: "approved" | "rejected";
  by: string;
  note?: string | null;
}

/** The contract both adapters implement. `lib/data.ts` picks one. */
export interface DataSource {
  getFeed(opts?: FeedOptions): Promise<FeedEvent[]>;
  getProjects(): Promise<ProjectSummary[]>;
  getProject(slug: string): Promise<ProjectDetail | null>;
  getUsage(window: UsageWindow): Promise<UsageSummary>;
  getWorkers(): Promise<Worker[]>;
  /** Tasks with their derived state, newest first; the tasks page and the feed's review strip read the `review` ones. Empty in mock mode. */
  getTasks(opts?: TaskListOptions): Promise<TaskView[]>;
  getModels(): Promise<ModelInfo[]>;
  writeEvent(event: NewEvent): Promise<FeedEvent | null>;
  getAssets(opts?: AssetListOptions): Promise<Asset[]>;
  getAsset(id: string): Promise<AssetDetail | null>;
  reviewAsset(id: string, review: AssetReview): Promise<Asset | null>;
  /** Copies the bytes to the public store and records the URL; null when unknown, throws when the store cannot publish. */
  publishAsset(id: string, by: string): Promise<Asset | null>;
}
