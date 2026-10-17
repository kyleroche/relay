/**
 * The function surface the relay CLI and hooks use, with two implementations: `localClient` over a database handle
 * (PGlite or DATABASE_URL) and `httpClient` over a hosted site's `/api/v1` and `/mcp`. `openHarness()` picks one from
 * `~/.harness/config.json` (`site`) and `~/.harness/credentials.json` (`token`), so every command is written once.
 */
import type { EventRow, ListEventsOpts, UsageSummaryRow } from "../db/events.ts";
import type { DecisionRow, PreferenceRow } from "../db/memory.ts";
import type { ProjectRow } from "../db/projects.ts";
import type { TaskState, TaskView } from "../db/tasks.ts";
import type { InviteRow } from "../db/oauth.ts";
import type { TokenRow } from "../db/tokens.ts";
import type { PublicWebhook } from "../db/webhooks.ts";
import type { CreateTaskInput } from "../tasks/create.ts";
import type { DeliveryResult } from "../webhooks/dispatch.ts";
import type { BriefIssue } from "../brief/index.ts";

export type ClientMode = "local" | "site";

/** `relay_event_log` / `POST /api/v1/events`: an external bot's note in the feed. Kind must start with `external.`. */
export interface ExternalEventInput {
  kind: string;
  project?: string | null;
  summary: string;
  url?: string | null;
  cost_equiv?: number;
  source?: string | null;
  payload?: Record<string, unknown>;
}

export interface ProjectUpsert {
  slug: string;
  repo?: string;
  path?: string;
  stack?: string;
  checkCmd?: string;
}

/** One file digest as `relay link` uploads it: the hash always, the summary when the local digest pass produced one. */
export interface DigestUpload {
  path: string;
  sha256: string;
  size: number;
  summary?: string | null;
  summary_sha?: string | null;
  tokens?: number | null;
}

/** A `step.usage` row made locally (digest or summary call) that the site should record too. */
export interface UsageUpload {
  lane: string;
  model: string | null;
  subscription: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_equiv: number;
  duration_ms: number | null;
  summary: string;
  ts: string;
}

export interface RecallQuery {
  project?: string;
  query: string;
  lane?: string;
}

export interface RecallResult {
  preferences: PreferenceRow[];
  decisions: DecisionRow[];
  /** Rendered text (what a hook injects); the only form a site answers with. */
  text: string;
}

export interface BriefQuery {
  project: string;
  intent: string;
  maxTokens: number;
  model?: string;
  lane?: string;
  issue?: BriefIssue;
}

export interface BriefResult {
  text: string;
  tokens: number;
  sections?: Array<{ name: string; tokens: number }>;
  omitted?: string[];
}

export interface DecideInput {
  /** null = global (local mode only; the site's tool is project-scoped). */
  project: string | null;
  text: string;
  source: string;
  sourceRef?: string;
  supersedesId?: number;
}

export interface PreferInput {
  key: string;
  value: string;
  scope: PreferenceRow["scope"];
  scopeId: string | null;
  reason?: string | null;
}

export interface WebhookInput {
  url: string;
  events: string[];
  project?: string | null;
  bearer?: string | null;
  secret?: string;
}

export interface SiteHealth {
  ok: boolean;
  detail: string;
}

/** `relay invite create`: who it is for, what it grants, how long it lasts, how many times it may be redeemed. */
export interface InviteInput {
  name: string;
  scopes: string[];
  expiresInSeconds?: number;
  uses?: number;
}

/** Who the caller is, as the backing store sees it (`GET /api/v1/whoami`, `relay_whoami`). */
export interface WhoAmI {
  actor: string;
  /** The token's name, or the actor in local mode. */
  name: string;
  scopes: string[];
  expires_at: string | null;
  /** db | env | shared | session | local */
  source: string;
}

export interface RelayClient {
  readonly mode: ClientMode;
  /** The site URL in site mode. */
  readonly site?: string;
  /** Who writes are attributed to in local mode; in site mode the token decides and this is informational. */
  readonly actor: string;

  // feed
  listEvents(opts?: ListEventsOpts): Promise<EventRow[]>;
  logEvent(input: ExternalEventInput): Promise<EventRow | undefined>;
  usageSummary(sinceIso: string): Promise<UsageSummaryRow[]>;

  // projects
  listProjects(): Promise<ProjectRow[]>;
  getProject(slug: string): Promise<ProjectRow | undefined>;
  registerProject(p: ProjectUpsert): Promise<void>;
  putDigests(slug: string, files: DigestUpload[], opts?: { prune?: boolean; usage?: UsageUpload[] }): Promise<{ files: number }>;
  putSummary(slug: string, summary: string, tokens: number, opts?: { usage?: UsageUpload[] }): Promise<void>;

  // memory
  recall(q: RecallQuery): Promise<RecallResult>;
  brief(q: BriefQuery): Promise<BriefResult>;
  decide(d: DecideInput): Promise<{ id: number }>;
  prefer(p: PreferInput): Promise<void>;
  listDecisions(project: string | null | undefined, opts?: { current?: boolean; limit?: number }): Promise<DecisionRow[]>;

  // tokens
  createToken(input: { name: string; scopes: string[] }): Promise<{ token: string; row: TokenRow }>;
  listTokens(opts?: { includeRevoked?: boolean }): Promise<TokenRow[]>;
  revokeToken(idOrName: string): Promise<TokenRow | undefined>;

  // tasks
  createTask(input: Omit<CreateTaskInput, "actor">): Promise<{ task_id: string; issue_url: string; created: boolean; task: TaskView }>;
  getTask(id: string): Promise<TaskView | undefined>;
  listTasks(opts?: { project?: string; state?: TaskState; limit?: number }): Promise<TaskView[]>;
  /** Approve a task in review: squash-merge its PR, delete the branch, write task.approved (tasks/review.ts). */
  approveTask(id: string): Promise<TaskView>;
  /** Send a task's PR back with a note: a PR comment plus task.changes_requested; the task is queued again. */
  requestChanges(id: string, note: string): Promise<TaskView>;

  // invites (approval without a browser)
  createInvite(input: InviteInput): Promise<{ code: string; invite: InviteRow }>;
  listInvites(opts?: { includeSpent?: boolean }): Promise<InviteRow[]>;
  revokeInvite(idOrName: string): Promise<InviteRow | undefined>;

  /** Who this client is to the backing store. */
  whoami(): Promise<WhoAmI>;

  // webhooks
  addWebhook(input: WebhookInput): Promise<{ webhook: PublicWebhook; secret: string }>;
  listWebhooks(opts?: { project?: string }): Promise<PublicWebhook[]>;
  removeWebhook(id: string): Promise<boolean>;
  testWebhook(id: string): Promise<DeliveryResult>;

  /** Is the backing store answering, and with what. */
  health(): Promise<SiteHealth>;
  close(): Promise<void>;
}
