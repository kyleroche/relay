/**
 * OpenAPI pieces for the integration surface (tasks, external events, tokens, webhooks, project uploads, usage), kept
 * out of app/openapi.json/route.ts so that file only spreads them in. Everything here is additive to the API.
 */
import { TASK_LANES, TASK_PRIORITIES, TASK_STATES, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES, WEBHOOK_EVENT_KINDS } from "@relay/core";

export const scopeDescriptions: Record<string, string> = { ...TOKEN_SCOPE_DESCRIPTIONS };

export const integrationTags = [
  { name: "tasks", description: "Tasks: GitHub issues with a lane label, addressed as owner/repo#n. State is derived from the feed (docs/INTEGRATIONS.md)." },
  { name: "events", description: "External bots logging their own external.* events into the feed." },
  { name: "tokens", description: "Bearer tokens for this site: mint (plaintext shown once), list, revoke." },
  { name: "webhooks", description: "Outbound webhooks: signed POSTs for the event kinds a receiver subscribes to (docs/FEED.md)." },
];

type Response = (description: string, schemaRef: string) => unknown;
type ProblemResponse = (description: string, extraHeaders?: Record<string, unknown>) => unknown;

export function integrationPaths(h: { response: Response; problemResponse: ProblemResponse; commonErrors: Record<string, unknown> }): Record<string, unknown> {
  const { response, problemResponse, commonErrors } = h;
  const slugParam = { name: "slug", in: "path", required: true, schema: { type: "string" } };
  const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const notImplemented = problemResponse("This deployment has no database (mock mode).");
  return {
    "/usage": {
      get: {
        operationId: "getUsage",
        tags: ["feed"],
        summary: "Per-subscription usage totals",
        description: "step.usage totals grouped by subscription since `since` (default: seven days ago); the same query as `relay usage` and the ledger view.",
        parameters: [{ name: "since", in: "query", schema: { type: "string", format: "date-time" } }],
        responses: { "200": response("Totals per subscription.", "#/components/schemas/UsageTotals"), "400": problemResponse("Invalid parameter."), ...commonErrors },
      },
    },
    "/projects/{slug}/decisions": {
      get: {
        operationId: "listProjectDecisions",
        tags: ["projects"],
        summary: "Decisions for a project, including superseded ones",
        security: [{ bearer: ["memory:read"] }],
        parameters: [slugParam, { name: "current", in: "query", schema: { type: "boolean" }, description: "Only decisions whose validity is open." }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }],
        responses: { "200": response("Decisions newest first.", "#/components/schemas/DecisionHistory"), "404": problemResponse("No such project."), ...commonErrors },
      },
    },
    "/projects/{slug}": {
      put: {
        operationId: "putProject",
        tags: ["projects"],
        summary: "Register or refresh a project",
        description: "What `relay link` does in site mode: creates the project row or updates the fields given. The web app never reads the repository itself.",
        security: [{ bearer: ["projects:write"] }],
        parameters: [slugParam],
        requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectUpsert" } } } },
        responses: { "200": response("Refreshed.", "#/components/schemas/ProjectRowEnvelope"), "201": response("Created.", "#/components/schemas/ProjectRowEnvelope"), "400": problemResponse("Bad slug or repo."), "501": notImplemented, ...commonErrors },
      },
    },
    "/projects/{slug}/digests": {
      put: {
        operationId: "putProjectDigests",
        tags: ["projects"],
        summary: "Upload file hashes and digests",
        description: "`relay link` in site mode hashes and digests files on the user's machine (the Claude login never leaves it) and uploads the result. `prune` removes rows for files not in this upload; `usage` carries the step.usage rows the digest calls produced.",
        security: [{ bearer: ["projects:write"] }],
        parameters: [slugParam],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DigestUpload" } } } },
        responses: { "200": response("Counts.", "#/components/schemas/DigestUploadResult"), "400": problemResponse("Bad file entry."), "404": problemResponse("No such project."), "501": notImplemented, ...commonErrors },
      },
    },
    "/projects/{slug}/summary": {
      put: {
        operationId: "putProjectSummary",
        tags: ["projects"],
        summary: "Upload the project brief",
        description: "The 150-700 word summary with the five headings `relay link` wrote locally; validated the same way before it is stored.",
        security: [{ bearer: ["projects:write"] }],
        parameters: [slugParam],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SummaryUpload" } } } },
        responses: { "200": response("Stored.", "#/components/schemas/SummaryUploadResult"), "400": problemResponse("Summary rejected."), "404": problemResponse("No such project."), "501": notImplemented, ...commonErrors },
      },
    },
    "/tasks": {
      get: {
        operationId: "listTasks",
        tags: ["tasks"],
        summary: "List tasks with derived state",
        security: [{ bearer: ["tasks:read"] }],
        parameters: [
          { name: "project", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string", enum: TASK_STATES } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: { "200": response("Tasks newest first.", "#/components/schemas/TaskList"), "400": problemResponse("Invalid parameter."), ...commonErrors },
      },
      post: {
        operationId: "createTask",
        tags: ["tasks"],
        summary: "Open a task",
        description:
          "Opens a GitHub issue in the project's repository with the `agent:<lane>` label (and `priority:<p>`), records the task and writes `issue.opened` and `task.created`. With `idempotency_key`, a repeat call returns the first task (200) and opens nothing. The issue body ends with `<!-- relay:task key=… -->`. Needs a GitHub token on the server (GITHUB_TOKEN or GITHUB_APP_TOKEN); 503 without one.",
        security: [{ bearer: ["tasks:write"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TaskCreate" } } } },
        responses: {
          "201": response("Created.", "#/components/schemas/TaskCreated"),
          "200": response("An earlier task with the same idempotency key.", "#/components/schemas/TaskCreated"),
          "400": problemResponse("Bad lane, priority or missing fields."),
          "404": problemResponse("No such project."),
          "501": notImplemented,
          "503": problemResponse("No GitHub credential configured on the server."),
          ...commonErrors,
        },
      },
    },
    "/tasks/{owner}/{repo}%23{issue}": {
      get: {
        operationId: "getTask",
        tags: ["tasks"],
        summary: "One task with its derived state",
        description: "The task id is `owner/repo#n`; send the `#` as `%23`, e.g. `/tasks/acme/site%2342`.",
        security: [{ bearer: ["tasks:read"] }],
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "issue", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: { "200": response("The task.", "#/components/schemas/Task"), "400": problemResponse("Bad task id."), "404": problemResponse("No such task."), ...commonErrors },
      },
    },
    "/events": {
      post: {
        operationId: "logEvent",
        tags: ["events"],
        summary: "Log an external event",
        description: "Appends one `external.*` row to the feed. The actor is always `bot:<token name>` (or `human:<login>` for a signed-in viewer); any actor in the body is ignored. Matching webhooks are notified.",
        security: [{ bearer: ["events:write"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ExternalEvent" } } } },
        responses: { "201": response("The written event.", "#/components/schemas/EventEnvelope"), "400": problemResponse("Bad kind or missing summary."), "404": problemResponse("No such project."), "501": notImplemented, ...commonErrors },
      },
    },
    "/tokens": {
      get: {
        operationId: "listTokens",
        tags: ["tokens"],
        summary: "List tokens (never the secret)",
        security: [{ bearer: ["tokens:write"] }],
        parameters: [{ name: "all", in: "query", schema: { type: "string", enum: ["1"] }, description: "Include revoked tokens." }],
        responses: { "200": response("Tokens.", "#/components/schemas/TokenList"), "501": notImplemented, ...commonErrors },
      },
      post: {
        operationId: "createToken",
        tags: ["tokens"],
        summary: "Mint a token",
        description: "Returns the plaintext once. The /tokens page (signed-in) and `relay token create` in site mode call this. Only the SHA-256 is stored.",
        security: [{ bearer: ["tokens:write"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TokenCreate" } } } },
        responses: { "201": response("The token, shown once.", "#/components/schemas/TokenCreated"), "400": problemResponse("Bad name or scopes."), "501": notImplemented, ...commonErrors },
      },
    },
    "/tokens/{id}": {
      delete: {
        operationId: "revokeToken",
        tags: ["tokens"],
        summary: "Revoke a token by id or name",
        security: [{ bearer: ["tokens:write"] }],
        parameters: [idParam],
        responses: { "200": response("Revoked.", "#/components/schemas/TokenRevoked"), "404": problemResponse("No live token matches."), "501": notImplemented, ...commonErrors },
      },
    },
    "/webhooks": {
      get: {
        operationId: "listWebhooks",
        tags: ["webhooks"],
        summary: "List outbound webhooks",
        security: [{ bearer: ["webhooks:write"] }],
        parameters: [{ name: "project", in: "query", schema: { type: "string" } }],
        responses: { "200": response("Hooks, without secrets.", "#/components/schemas/WebhookList"), "501": notImplemented, ...commonErrors },
      },
      post: {
        operationId: "createWebhook",
        tags: ["webhooks"],
        summary: "Add an outbound webhook",
        description: "The signing secret is generated when absent and returned once in this response. `bearer` is sent as `Authorization: Bearer` on every delivery. Event filters: exact kinds, a prefix ending in `.`, or `*`.",
        security: [{ bearer: ["webhooks:write"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookCreate" } } } },
        responses: { "201": response("The hook and its secret.", "#/components/schemas/WebhookCreated"), "400": problemResponse("Bad url or events."), "404": problemResponse("No such project."), "501": notImplemented, ...commonErrors },
      },
    },
    "/webhooks/{id}": {
      get: {
        operationId: "getWebhook",
        tags: ["webhooks"],
        summary: "One webhook with its last deliveries",
        security: [{ bearer: ["webhooks:write"] }],
        parameters: [idParam],
        responses: { "200": response("The hook and up to 20 deliveries.", "#/components/schemas/WebhookDetail"), "404": problemResponse("No such webhook."), "501": notImplemented, ...commonErrors },
      },
      delete: {
        operationId: "deleteWebhook",
        tags: ["webhooks"],
        summary: "Remove a webhook",
        security: [{ bearer: ["webhooks:write"] }],
        parameters: [idParam],
        responses: { "200": response("Removed.", "#/components/schemas/WebhookRemoved"), "404": problemResponse("No such webhook."), "501": notImplemented, ...commonErrors },
      },
    },
    "/webhooks/{id}/test": {
      post: {
        operationId: "testWebhook",
        tags: ["webhooks"],
        summary: "Send a signed test.ping now",
        security: [{ bearer: ["webhooks:write"] }],
        parameters: [idParam],
        responses: { "200": response("Delivered.", "#/components/schemas/Delivery"), "502": response("The receiver did not accept it; details in the body.", "#/components/schemas/Delivery"), "404": problemResponse("No such webhook."), "501": notImplemented, ...commonErrors },
      },
    },
  };
}

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });

export const integrationSchemas: Record<string, unknown> = {
  UsageTotals: {
    type: "object",
    properties: {
      since: { type: "string", format: "date-time" },
      subscriptions: {
        type: "array",
        items: { type: "object", properties: { subscription: { type: "string" }, calls: { type: "integer" }, tokens_in: { type: "integer" }, tokens_out: { type: "integer" }, cache_read: { type: "integer" }, cost_equiv: { type: "number" }, avg_ctx: { type: "number" } } },
      },
    },
  },
  DecisionRow: {
    type: "object",
    properties: {
      id: { type: "integer" },
      project: nullable("string"),
      text: { type: "string" },
      source: nullable("string"),
      source_ref: nullable("string"),
      valid_from: { type: "string", format: "date-time" },
      valid_to: nullable("string", { format: "date-time" }),
      superseded_by: nullable("integer"),
      created_at: { type: "string", format: "date-time" },
    },
  },
  DecisionHistory: { type: "object", properties: { decisions: { type: "array", items: { $ref: "#/components/schemas/DecisionRow" } }, count: { type: "integer" } } },
  ProjectUpsert: { type: "object", properties: { repo: { type: "string", description: "owner/name" }, path: { type: "string" }, stack: { type: "string" }, check_cmd: { type: "string" } } },
  ProjectRow: {
    type: "object",
    properties: {
      slug: { type: "string" },
      repo: nullable("string"),
      path: nullable("string"),
      stack: nullable("string"),
      check_cmd: nullable("string"),
      summary: nullable("string"),
      summary_tokens: nullable("integer"),
      created_at: nullable("string", { format: "date-time" }),
      updated_at: nullable("string", { format: "date-time" }),
    },
  },
  ProjectRowEnvelope: { type: "object", properties: { project: { $ref: "#/components/schemas/ProjectRow" }, created: { type: "boolean" } } },
  UsageUpload: {
    type: "object",
    description: "A step.usage row made on the user's machine.",
    properties: {
      lane: { type: "string" },
      model: nullable("string"),
      subscription: nullable("string"),
      tokens_in: { type: "integer" },
      tokens_out: { type: "integer" },
      cache_read: { type: "integer" },
      cache_write: { type: "integer" },
      cost_equiv: { type: "number" },
      duration_ms: nullable("integer"),
      summary: { type: "string" },
      ts: { type: "string", format: "date-time" },
    },
  },
  DigestUpload: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        maxItems: 5000,
        items: {
          type: "object",
          required: ["path", "sha256", "size"],
          properties: { path: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, size: { type: "integer" }, summary: { type: "string" }, summary_sha: { type: "string" }, tokens: { type: "integer" } },
        },
      },
      prune: { type: "boolean", description: "Remove digests for files absent from this upload." },
      usage: { type: "array", items: { $ref: "#/components/schemas/UsageUpload" } },
    },
  },
  DigestUploadResult: { type: "object", properties: { files: { type: "integer" }, summarized: { type: "integer" }, removed: { type: "integer" }, usage: { type: "integer" } } },
  SummaryUpload: { type: "object", required: ["summary"], properties: { summary: { type: "string" }, tokens: { type: "integer" }, usage: { type: "array", items: { $ref: "#/components/schemas/UsageUpload" } } } },
  SummaryUploadResult: { type: "object", properties: { slug: { type: "string" }, tokens: { type: "integer" }, usage: { type: "integer" } } },
  Task: {
    type: "object",
    required: ["id", "project", "repo", "issue", "state", "issue_url"],
    properties: {
      id: { type: "string", description: "owner/repo#n" },
      project: { type: "string" },
      repo: { type: "string" },
      issue: { type: "integer" },
      idempotency_key: nullable("string"),
      created_by: { type: "string" },
      created_at: { type: "string", format: "date-time" },
      state: { type: "string", enum: TASK_STATES, description: "Derived from the feed: issue.labeled → queued, run.started → running, pr.opened or a finished run → review, pr.merged or issue.closed → done, run.failed or a failed run → failed." },
      runner: nullable("string", { description: "runner:<name> that last claimed it." }),
      lane: nullable("string"),
      pr: nullable("integer"),
      pr_url: nullable("string", { format: "uri" }),
      issue_url: { type: "string", format: "uri" },
      summary: nullable("string", { description: "Summary line of the latest event." }),
      updated_at: nullable("string", { format: "date-time" }),
      last_kind: nullable("string"),
      events: { type: "integer" },
    },
  },
  TaskList: { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } }, count: { type: "integer" } } },
  TaskCreate: {
    type: "object",
    required: ["project", "title", "lane"],
    properties: {
      project: { type: "string" },
      title: { type: "string", maxLength: 256 },
      body: { type: "string", description: "Markdown; the brief the lane reads." },
      lane: { type: "string", enum: TASK_LANES },
      priority: { type: "string", enum: TASK_PRIORITIES },
      idempotency_key: { type: "string", maxLength: 200 },
    },
  },
  TaskCreated: { type: "object", required: ["task_id", "issue_url", "created", "task"], properties: { task_id: { type: "string" }, issue_url: { type: "string", format: "uri" }, created: { type: "boolean" }, task: { $ref: "#/components/schemas/Task" } } },
  ExternalEvent: {
    type: "object",
    required: ["kind", "summary"],
    properties: {
      kind: { type: "string", pattern: "^external\\.[a-z0-9_.-]+$", description: "external.<something>" },
      project: { type: "string" },
      summary: { type: "string", maxLength: 500 },
      url: { type: "string", format: "uri" },
      cost_equiv: { type: "number", minimum: 0 },
      source: { type: "string", description: "The external system, kept in payload.source." },
      payload: { type: "object", additionalProperties: true },
    },
  },
  EventEnvelope: { type: "object", properties: { event: { oneOf: [{ $ref: "#/components/schemas/Event" }, { type: "null" }] } } },
  Token: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      scopes: { type: "array", items: { type: "string", enum: [...TOKEN_SCOPES] } },
      created_by: { type: "string" },
      created_at: { type: "string", format: "date-time" },
      last_used_at: nullable("string", { format: "date-time" }),
      revoked_at: nullable("string", { format: "date-time" }),
    },
  },
  TokenList: { type: "object", properties: { tokens: { type: "array", items: { $ref: "#/components/schemas/Token" } }, count: { type: "integer" } } },
  TokenCreate: { type: "object", required: ["name", "scopes"], properties: { name: { type: "string", maxLength: 80 }, scopes: { type: "array", items: { type: "string", enum: [...TOKEN_SCOPES] } } } },
  TokenCreated: { allOf: [{ $ref: "#/components/schemas/Token" }, { type: "object", required: ["token"], properties: { token: { type: "string", description: "The plaintext, shown once." } } }] },
  TokenRevoked: { type: "object", properties: { revoked: { $ref: "#/components/schemas/Token" } } },
  Webhook: {
    type: "object",
    properties: {
      id: { type: "string" },
      project: nullable("string", { description: "null = every project" }),
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" }, description: `Kinds (${WEBHOOK_EVENT_KINDS.slice(0, 6).join(", ")}, …), prefixes ending in '.', or '*'.` },
      active: { type: "boolean" },
      has_bearer: { type: "boolean" },
      created_by: { type: "string" },
      created_at: { type: "string", format: "date-time" },
    },
  },
  WebhookList: { type: "object", properties: { webhooks: { type: "array", items: { $ref: "#/components/schemas/Webhook" } }, count: { type: "integer" } } },
  WebhookCreate: {
    type: "object",
    required: ["url", "events"],
    properties: {
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" } },
      project: { type: "string" },
      bearer: { type: "string", description: "Sent as Authorization: Bearer on every delivery." },
      secret: { type: "string", description: "HMAC key; generated when omitted." },
    },
  },
  WebhookCreated: { type: "object", required: ["webhook", "secret"], properties: { webhook: { $ref: "#/components/schemas/Webhook" }, secret: { type: "string", description: "Shown once." } } },
  Delivery: {
    type: "object",
    properties: {
      delivery_id: { type: "string" },
      webhook_id: { type: "string" },
      status: { type: "string", enum: ["delivered", "failed"] },
      attempts: { type: "integer" },
      last_status: nullable("integer"),
      error: nullable("string"),
    },
  },
  DeliveryRow: {
    type: "object",
    properties: {
      id: { type: "string" },
      webhook_id: { type: "string" },
      event_id: nullable("integer"),
      kind: { type: "string" },
      status: { type: "string", enum: ["pending", "delivered", "failed"] },
      attempts: { type: "integer" },
      last_error: nullable("string"),
      delivered_at: nullable("string", { format: "date-time" }),
      created_at: { type: "string", format: "date-time" },
    },
  },
  WebhookDetail: { type: "object", properties: { webhook: { $ref: "#/components/schemas/Webhook" }, deliveries: { type: "array", items: { $ref: "#/components/schemas/DeliveryRow" } } } },
  WebhookRemoved: { type: "object", properties: { removed: { type: "string" } } },
};
