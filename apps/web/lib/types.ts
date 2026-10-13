import type { EventKind } from "./events.ts";

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
export interface PlanMeter {
  id: string;
  label: string;
  subscription: Subscription;
  percentUsed: number | null;
  resetsAt: string | null;
  resetsIn: string | null;
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
  status: WorkerStatus;
  lanes: Lane[];
  runsToday: number;
  current: { project: string; issue: number; startedAt: string } | null;
}

/** The contract both adapters implement. `lib/data.ts` picks one. */
export interface DataSource {
  getFeed(opts?: FeedOptions): Promise<FeedEvent[]>;
  getProjects(): Promise<ProjectSummary[]>;
  getProject(slug: string): Promise<ProjectDetail | null>;
  getUsage(window: UsageWindow): Promise<UsageSummary>;
  getWorkers(): Promise<Worker[]>;
  getModels(): Promise<ModelInfo[]>;
  writeEvent(event: NewEvent): Promise<FeedEvent | null>;
}
