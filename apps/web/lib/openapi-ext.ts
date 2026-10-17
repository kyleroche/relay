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
  { name: "access", description: "Who the caller is, pending device-flow approvals, and invite codes: the pieces of the authorization server that live under /api/v1 (docs/INTEGRATIONS.md)." },
  { name: "work", description: "The worker protocol behind `relay work` (docs/WORKERS.md): register, heartbeat, claim a leased task, report the run." },
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
    "/whoami": {
      get: {
        operationId: "whoami",
        tags: ["access"],
        summary: "Who am I",
        description: "The caller's token name, scopes, expiry and how it authenticated (db, env, shared, session). Any valid credential may ask; anonymous callers get 401 with the challenge that names the authorization server.",
        security: [{ bearer: [] }, { oauth2: [] }],
        responses: { "200": response("The caller.", "#/components/schemas/WhoAmI"), ...commonErrors },
      },
    },
    "/access": {
      get: {
        operationId: "listAccessRequests",
        tags: ["access"],
        summary: "Device-flow requests waiting for a decision",
        security: [{ bearer: ["tokens:write"] }],
        responses: { "200": response("Pending requests, newest first.", "#/components/schemas/AccessRequestList"), "501": notImplemented, ...commonErrors },
      },
    },
    "/access/{user_code}/approve": {
      post: {
        operationId: "approveAccessRequest",
        tags: ["access"],
        summary: "Approve or deny a device request by its code",
        description: "What a reply over chat can do: approve (default) or deny the request a CLI or bot started with `relay setup --site`. The device receives its token on its next poll. Writes access.granted or access.denied. A token may approve only scopes it holds itself and never tokens:write (403 otherwise; a signed-in person is unrestricted). The MCP twin is relay_access_approve.",
        security: [{ bearer: ["tokens:write"] }],
        parameters: [{ name: "user_code", in: "path", required: true, schema: { type: "string", pattern: "^RLAY-[A-Z0-9]{4,8}$" }, description: "The code shown to the person, e.g. RLAY-4F7Q; case and dashes do not matter." }],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { decision: { type: "string", enum: ["approve", "deny"], default: "approve" } } } } } },
        responses: { "200": response("Decided.", "#/components/schemas/AccessDecision"), "404": problemResponse("No pending request with that code."), "410": problemResponse("The request expired."), "501": notImplemented, ...commonErrors },
      },
    },
    "/invites": {
      get: {
        operationId: "listInvites",
        tags: ["access"],
        summary: "List invites (never the code)",
        security: [{ bearer: ["tokens:write"] }],
        parameters: [{ name: "all", in: "query", schema: { type: "string", enum: ["1"] }, description: "Include spent, expired and revoked invites." }],
        responses: { "200": response("Invites.", "#/components/schemas/InviteList"), "501": notImplemented, ...commonErrors },
      },
      post: {
        operationId: "createInvite",
        tags: ["access"],
        summary: "Mint a one-time invite code",
        description: "What `relay invite create` calls. The code is returned once. Redeeming it (`relay setup --site <url> --invite <code>`, or grant `urn:relay:invite` at /oauth/token) yields a token named oauth:<name> with exactly these scopes and no approval step. A token may invite only to scopes it holds itself and never tokens:write (403). The MCP twin is relay_invite_create.",
        security: [{ bearer: ["tokens:write"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InviteCreate" } } } },
        responses: { "201": response("The invite and its code, shown once.", "#/components/schemas/InviteCreated"), "400": problemResponse("Bad name, scopes, duration or uses."), "501": notImplemented, ...commonErrors },
      },
    },
    "/invites/{id}": {
      delete: {
        operationId: "revokeInvite",
        tags: ["access"],
        summary: "Revoke an invite by id or name",
        security: [{ bearer: ["tokens:write"] }],
        parameters: [idParam],
        responses: { "200": response("Revoked.", "#/components/schemas/InviteRevoked"), "404": problemResponse("No live invite matches."), "501": notImplemented, ...commonErrors },
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
    "/workers": {
      get: {
        operationId: "listWorkers",
        tags: ["work"],
        summary: "Workers with their derived state and current task",
        description: "Every machine that registered through `relay work`. `state` is online (heartbeat under 2 minutes), idle (under an hour) or offline; `current` is the live claim, if any.",
        security: [{ bearer: ["feed:read"] }],
        responses: { "200": response("Workers, most recently seen first.", "#/components/schemas/WorkerList"), ...commonErrors },
      },
      post: {
        operationId: "registerWorker",
        tags: ["work"],
        summary: "Register (or refresh) a worker",
        description: "Upserts the worker by name; the id is stable across restarts and is what the other work routes take. Writes `worker.registered` on first sight and `worker.online` when a worker comes back after an offline report.",
        security: [{ bearer: ["work:claim"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WorkerRegister" } } } },
        responses: { "201": response("Registered.", "#/components/schemas/WorkerRegistered"), "200": response("Refreshed.", "#/components/schemas/WorkerRegistered"), "400": problemResponse("Bad name or lanes."), "501": notImplemented, ...commonErrors },
      },
    },
    "/workers/{id}/heartbeat": {
      post: {
        operationId: "heartbeatWorker",
        tags: ["work"],
        summary: "Heartbeat: touch last_seen and renew this worker's leases",
        description: "Called every 60 seconds by `relay work`. Every live claim the worker holds is extended to 30 minutes from now. `status: offline` records a clean shutdown (`worker.offline`).",
        security: [{ bearer: ["work:claim"] }],
        parameters: [idParam],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["online", "offline"] } } } } } },
        responses: { "200": response("The worker and its leases.", "#/components/schemas/Heartbeat"), "404": problemResponse("No such worker."), "501": notImplemented, ...commonErrors },
      },
    },
    "/work/claim": {
      post: {
        operationId: "claimWork",
        tags: ["work"],
        summary: "Claim the oldest queued task this worker can run",
        description:
          "Expired leases are released first. Candidates are queued tasks whose lane is among the worker's lanes (optionally narrowed by `lanes`) and whose project's `lane.labels` preference is satisfied by the worker's labels. The claim is taken atomically (one live claim per task) under a 30-minute lease; the task's derived state becomes `claimed`. `claim` is null when nothing is claimable. The issue text is included when the server holds a GitHub token.",
        security: [{ bearer: ["work:claim"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ClaimRequest" } } } },
        responses: { "200": response("A claim, or null.", "#/components/schemas/ClaimResponse"), "400": problemResponse("Missing worker_id."), "404": problemResponse("No such worker."), "501": notImplemented, ...commonErrors },
      },
    },
    "/work/{owner}/{repo}%23{issue}/start": {
      post: {
        operationId: "startWork",
        tags: ["work"],
        summary: "Report that the run started",
        description: "The clone is ready and the lane is about to run: writes `run.started` as `runner:<worker name>`; the task is `running`. 409 when the worker holds no live claim on the task.",
        security: [{ bearer: ["work:claim"] }],
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "issue", in: "path", required: true, schema: { type: "integer" } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["worker_id"], properties: { worker_id: { type: "string" }, branch: { type: "string" }, host: { type: "string" } } } } } },
        responses: { "200": response("Recorded.", "#/components/schemas/WorkReport"), "400": problemResponse("Bad task id or missing worker_id."), "404": problemResponse("No such worker or task."), "409": problemResponse("No live claim."), "501": notImplemented, ...commonErrors },
      },
    },
    "/work/{owner}/{repo}%23{issue}/release": {
      post: {
        operationId: "releaseWork",
        tags: ["work"],
        summary: "End the lease and report the run",
        description:
          "`finished` writes `run.finished` (with `conclusion`, default success, the PR number and url); `failed` writes `run.failed` with `error`; `released` only frees the lease, so the task is queued again. `usage` becomes one `step.usage` row attributed to `agent:<lane>`; the worker's PR comment carries the same numbers for humans and is not counted twice. 409 when the worker holds no live claim.",
        security: [{ bearer: ["work:claim"] }],
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "issue", in: "path", required: true, schema: { type: "integer" } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReleaseRequest" } } } },
        responses: { "200": response("Recorded.", "#/components/schemas/WorkReport"), "400": problemResponse("Bad outcome or task id."), "404": problemResponse("No such worker or task."), "409": problemResponse("No live claim."), "501": notImplemented, ...commonErrors },
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
  WhoAmI: {
    type: "object",
    required: ["actor", "name", "scopes", "expires_at", "source"],
    properties: {
      actor: { type: "string", description: "token:<name> or human:<login>; writes are attributed to bot:<name> or human:<login>." },
      name: { type: "string", description: "The token's name, e.g. oauth:grok-bot or ci-runner." },
      scopes: { type: "array", items: { type: "string", enum: [...TOKEN_SCOPES] } },
      expires_at: nullable("string", { format: "date-time", description: "Null for operator-minted tokens." }),
      source: { type: "string", enum: ["db", "env", "shared", "session"] },
    },
  },
  AccessRequest: {
    type: "object",
    properties: {
      user_code: { type: "string", example: "RLAY-4F7Q" },
      client_name: { type: "string" },
      client_id: { type: "string" },
      scopes: { type: "array", items: { type: "string", enum: [...TOKEN_SCOPES] } },
      created_at: { type: "string", format: "date-time" },
      expires_at: { type: "string", format: "date-time" },
      approve: { type: "string", description: "Path to POST a decision to." },
    },
  },
  AccessRequestList: { type: "object", properties: { requests: { type: "array", items: { $ref: "#/components/schemas/AccessRequest" } }, count: { type: "integer" } } },
  AccessDecision: { type: "object", properties: { user_code: { type: "string" }, status: { type: "string", enum: ["approved", "denied"] }, client_name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, decided_by: nullable("string") } },
  Invite: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", description: "Who it is for; the redeemed token is oauth:<name>." },
      scopes: { type: "array", items: { type: "string", enum: [...TOKEN_SCOPES] } },
      uses_left: { type: "integer" },
      max_uses: { type: "integer" },
      expires_at: { type: "string", format: "date-time" },
      created_by: { type: "string" },
      created_at: { type: "string", format: "date-time" },
      revoked_at: nullable("string", { format: "date-time" }),
      last_redeemed_at: nullable("string", { format: "date-time" }),
    },
  },
  InviteList: { type: "object", properties: { invites: { type: "array", items: { $ref: "#/components/schemas/Invite" } }, count: { type: "integer" } } },
  InviteCreate: {
    type: "object",
    required: ["name", "scopes"],
    properties: {
      name: { type: "string", maxLength: 80 },
      scopes: { type: "array", items: { type: "string", enum: [...TOKEN_SCOPES] } },
      expires_in: { oneOf: [{ type: "string", pattern: "^\\d+[smhdw]?$" }, { type: "integer" }], description: "24h, 7d, or seconds; default 24h.", default: "24h" },
      uses: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
    },
  },
  InviteCreated: { type: "object", required: ["invite", "code"], properties: { invite: { $ref: "#/components/schemas/Invite" }, code: { type: "string", description: "Shown once." } } },
  InviteRevoked: { type: "object", properties: { revoked: { $ref: "#/components/schemas/Invite" } } },
  Worker: {
    type: "object",
    required: ["id", "name", "lanes", "labels", "last_seen", "status"],
    properties: {
      id: { type: "string" },
      name: { type: "string", description: "`runner:<name>` is this worker's actor in the feed." },
      host: { type: "string" },
      lanes: { type: "array", items: { type: "string", enum: ["claude", "codex", "grok"] } },
      labels: { type: "array", items: { type: "string" }, description: "Capabilities matched against a project's `lane.labels` preference." },
      version: { type: "string" },
      last_seen: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["online", "offline"], description: "What the worker last reported." },
      created_at: { type: "string", format: "date-time" },
    },
  },
  Claim: {
    type: "object",
    required: ["id", "task_id", "worker_id", "lease_until", "claimed_at"],
    properties: {
      id: { type: "string" },
      task_id: { type: "string" },
      worker_id: { type: "string" },
      lease_until: { type: "string", format: "date-time" },
      claimed_at: { type: "string", format: "date-time" },
      released_at: nullable("string", { format: "date-time" }),
      outcome: nullable("string", { enum: ["finished", "failed", "released", "expired", null] }),
    },
  },
  LiveClaim: { allOf: [{ $ref: "#/components/schemas/Claim" }, { type: "object", properties: { worker: { type: "string" }, project: { type: "string" }, repo: { type: "string" }, issue: { type: "integer" }, lane: nullable("string") } }] },
  WorkerView: {
    allOf: [
      { $ref: "#/components/schemas/Worker" },
      { type: "object", properties: { state: { type: "string", enum: ["online", "idle", "offline"], description: "Derived from last_seen." }, current: { oneOf: [{ $ref: "#/components/schemas/LiveClaim" }, { type: "null" }] } } },
    ],
  },
  WorkerList: { type: "object", properties: { workers: { type: "array", items: { $ref: "#/components/schemas/WorkerView" } }, count: { type: "integer" } } },
  WorkerRegister: {
    type: "object",
    required: ["name", "lanes"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      host: { type: "string" },
      lanes: { type: "array", items: { type: "string", enum: ["claude", "codex", "grok"] } },
      labels: { type: "array", items: { type: "string" } },
      version: { type: "string" },
    },
  },
  WorkerRegistered: { type: "object", properties: { worker: { $ref: "#/components/schemas/Worker" }, created: { type: "boolean" } } },
  Heartbeat: { type: "object", properties: { worker: { $ref: "#/components/schemas/Worker" }, leases: { type: "array", items: { $ref: "#/components/schemas/Claim" } } } },
  ClaimRequest: { type: "object", required: ["worker_id"], properties: { worker_id: { type: "string" }, lanes: { type: "array", items: { type: "string" } }, labels: { type: "array", items: { type: "string" } } } },
  ClaimResponse: {
    type: "object",
    properties: {
      claim: {
        oneOf: [
          {
            type: "object",
            properties: {
              claim: { $ref: "#/components/schemas/Claim" },
              task: { $ref: "#/components/schemas/Task" },
              issue: { oneOf: [{ type: "object", properties: { number: { type: "integer" }, title: { type: "string" }, body: { type: "string" }, url: { type: "string", format: "uri" } } }, { type: "null" }] },
              base: nullable("string", { description: "The repository's default branch when known." }),
            },
          },
          { type: "null" },
        ],
      },
    },
  },
  RunUsage: {
    type: "object",
    properties: {
      tool: { type: "string", description: "claude, codex, grok or fx" },
      model: nullable("string"),
      subscription: nullable("string"),
      tokens_in: { type: "integer" },
      tokens_out: { type: "integer" },
      cache_read: { type: "integer" },
      cache_write: { type: "integer" },
      cost_equiv: { type: "number" },
      duration_ms: { type: "integer" },
    },
  },
  ReleaseRequest: {
    type: "object",
    required: ["worker_id", "outcome"],
    properties: {
      worker_id: { type: "string" },
      outcome: { type: "string", enum: ["finished", "failed", "released"] },
      conclusion: { type: "string", description: "For finished runs; default success." },
      summary: { type: "string" },
      error: { type: "string" },
      pr: nullable("integer"),
      pr_url: nullable("string", { format: "uri" }),
      duration_ms: nullable("integer"),
      usage: { oneOf: [{ $ref: "#/components/schemas/RunUsage" }, { type: "null" }] },
    },
  },
  WorkReport: { type: "object", properties: { claim: { $ref: "#/components/schemas/Claim" }, events: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, kind: { type: "string" } } } } } },
};
