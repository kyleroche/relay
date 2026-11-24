/**
 * OpenAPI pieces for the integration surface (tasks, external events, tokens, project uploads, usage), kept
 * out of app/openapi.json/route.ts so that file only spreads them in. Everything here is additive to the API.
 */
import { board, LANE_NAME_PATTERN, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES, WORKER_LANES } from "@relay/core";

/** A lane name: the registry is open, so the schema is the shape and the built-ins are in the description (packages/core/src/tasks/lanes.ts). */
const LANE_PATTERN = `^${LANE_NAME_PATTERN}$`;
const LANE_WORDS = `Built-in: ${WORKER_LANES.join(", ")} (run on the user's own workers, machines running relay work), and ${board.ANY_LANE} (whichever code lane is free). Any other lane name is one another worker on the board serves (an app's own craft, e.g. embroidery).`;
const TASK_STATES = [...board.RELAY_STATES];
const laneSchema = (description: string) => ({ type: "string", pattern: LANE_PATTERN, description: `${description} ${LANE_WORDS}` });

export const scopeDescriptions: Record<string, string> = { ...TOKEN_SCOPE_DESCRIPTIONS };

export const integrationTags = [
  { name: "tasks", description: "Tasks: threads in a project's queue on the team's Vercel Board, addressed by the ID the board gave them. The board keeps each task's state (docs/WORKERS.md, docs/INTEGRATIONS.md)." },
  { name: "events", description: "External bots logging their own external.* events into the feed." },
  { name: "tokens", description: "Bearer tokens for this site: mint (plaintext shown once), list, revoke." },
  { name: "access", description: "Who the caller is, pending device-flow approvals, and invite codes: the pieces of the authorization server that live under /api/v1 (docs/INTEGRATIONS.md)." },
];

type Response = (description: string, schemaRef: string) => unknown;
type ProblemResponse = (description: string, extraHeaders?: Record<string, unknown>) => unknown;

export function integrationPaths(h: { response: Response; problemResponse: ProblemResponse; commonErrors: Record<string, unknown> }): Record<string, unknown> {
  const { response, problemResponse, commonErrors } = h;
  const slugParam = { name: "slug", in: "path", required: true, schema: { type: "string" } };
  const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const taskIdParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "The task's ID on the board (the ID of its thread's root message), URL-encoded." };
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
    "/projects/{slug}/github": {
      get: {
        operationId: "getProjectGitHub",
        tags: ["projects"],
        summary: "Will GitHub events for this project's repository reach this site?",
        description:
          "The check `relay link` prints as its `events` stage and `relay doctor` repeats per project. `app.installed` is the GitHub App's installation discovery for the repo (`GET /repos/{owner}/{repo}/installation`, cached up to an hour); false with `configured: false` when the site has no App. `install_url` is the App's install page, or this site's `/setup/github` when no App is configured. `webhook` counts the GitHub deliveries already recorded for the repo (events with a `github:` dedupe key: an organization or repository webhook, or the App's own) and is omitted in mock mode. Readable with `feed:read` or `projects:write` (the scope `relay link` holds), or a session.",
        security: [{ bearer: ["feed:read"] }, { bearer: ["projects:write"] }],
        parameters: [slugParam],
        responses: { "200": response("The status.", "#/components/schemas/ProjectGitHubStatus"), "404": problemResponse("No such project."), ...commonErrors },
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
        summary: "List tasks on the board",
        description: "Tasks oldest first, the order a queue is worked in. `state` is one of relay's states, `open` (everything not done or closed; the default) or `all`.",
        security: [{ bearer: ["tasks:read"] }],
        parameters: [
          { name: "project", in: "query", schema: { type: "string" }, description: "One project's queue." },
          { name: "state", in: "query", schema: { type: "string", enum: [...TASK_STATES, "open", "all"], default: "open" } },
          { name: "lane", in: "query", schema: { type: "string", pattern: LANE_PATTERN } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: { "200": response("Tasks oldest first.", "#/components/schemas/TaskList"), "400": problemResponse("Invalid parameter."), "502": problemResponse("The board could not be reached."), ...commonErrors },
      },
      post: {
        operationId: "createTask",
        tags: ["tasks"],
        summary: "Open a task",
        description:
          "Opens a thread in the project's queue on the board (`work/<project>`), labelled with its lane and model, as the caller's profile. The repository is the one the project is registered with, never the caller's word. Text the injection gate's pre-check flags is held as the task is made. With `idempotency_key`, a repeat call by the same caller returns the first task (200) and opens nothing. A lane no worker serves is refused with the lanes that have one.",
        security: [{ bearer: ["tasks:write"] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TaskCreate" } } } },
        responses: {
          "201": response("Created.", "#/components/schemas/TaskCreated"),
          "200": response("An earlier task with the same idempotency key.", "#/components/schemas/TaskCreated"),
          "400": problemResponse("A missing field, a bad lane, a lane no worker serves, or a project without a repository."),
          "404": problemResponse("No such project."),
          "501": notImplemented,
          "502": problemResponse("The board could not be reached."),
          ...commonErrors,
        },
      },
    },
    "/tasks/{id}": {
      get: {
        operationId: "getTask",
        tags: ["tasks"],
        summary: "One task with its usage and notes",
        description: "The task as the board has it, the usage rows posted in its thread and the notes people (and agents that are not relay's runner) left there. `id` is the task's ID on the board, URL-encoded.",
        security: [{ bearer: ["tasks:read"] }],
        parameters: [taskIdParam],
        responses: { "200": response("The task.", "#/components/schemas/TaskDetail"), "400": problemResponse("Bad path."), "404": problemResponse("No such task."), "502": problemResponse("The board could not be reached."), ...commonErrors },
      },
    },
    "/tasks/{id}/approve": {
      post: {
        operationId: "approveTask",
        tags: ["tasks"],
        summary: "Approve a task in review",
        description:
          "With a pull request: squash-merges it through GitHub, deletes the head branch and completes the task. The pull request is the one the worker's hold names, and it is merged only when its head is a branch relay pushed for this task. With outputs instead (the nodes lane): completes the task. With a proposed plan (a planning task, held `awaiting_plan`): opens the plan's tasks as the approver, each waiting for the ones it needs, completes the planning task and answers their IDs in `opened`; nothing of a plan is opened before that. With a report (a review hold whose reason is `report`): completes the task as read. A signed-in person may approve anything in review; a bot's token must hold `tasks:write`, and a bot never approves a task it opened (403). Before anything merges the site checks that its deployment can settle the task on the board (403 when it neither opened the task nor manages the queue). A task whose own pull request is already merged is finished from any open state, and an approval that finds the task already completed by GitHub's delivery is a success. When GitHub refuses the merge (conflicts, required checks, permissions) the refusal is a line in the task's thread and the answer is 502; the task stays in review.",
        security: [{ bearer: ["tasks:write"] }],
        parameters: [taskIdParam],
        responses: {
          "200": response("Approved; the completed task, with the merge when there was one.", "#/components/schemas/TaskApproved"),
          "403": problemResponse("A bot approving a task it opened, or a deployment that cannot settle the task on the board."),
          "404": problemResponse("No such task."),
          "409": problemResponse("Not in review, nothing to approve, or the pull request is closed or is not this task's."),
          "501": notImplemented,
          "502": problemResponse("GitHub refused the merge or could not be read; the task's thread has its message."),
          "503": problemResponse("No GitHub credential configured on the server."),
          ...commonErrors,
        },
      },
    },
    "/tasks/{id}/request-changes": {
      post: {
        operationId: "requestTaskChanges",
        tags: ["tasks"],
        summary: "Send a task in review back with a note",
        description: "The note becomes a reply in the task's thread and a comment on its pull request, and the hold is lifted: the task is `queued`, and the next run reads the whole thread and pushes to the same branch.",
        security: [{ bearer: ["tasks:write"] }],
        parameters: [taskIdParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["note"], properties: { note: { type: "string", maxLength: 6000, description: "What should change; written for the model that will act on it." } } } } } },
        responses: {
          "200": response("Sent back; the updated task (state queued).", "#/components/schemas/Task"),
          "400": problemResponse("An empty note, or one over 6,000 characters."),
          "404": problemResponse("No such task."),
          "409": problemResponse("Not in review."),
          "501": notImplemented,
          ...commonErrors,
        },
      },
    },
    "/tasks/{id}/close": {
      post: {
        operationId: "closeTask",
        tags: ["tasks"],
        summary: "Close a task without a merge",
        description:
          "For a task opened by mistake, against a spec the repository does not match, or a duplicate. The task is canceled on the board with `reason`, which also stops a run in progress at its next look. On GitHub, best effort: its open pull request is closed and the branch deleted, and the issue it answers is closed as not planned (`github` in the answer says what happened). A step's task that was looking at it is called off; work that waited for it as a step goes to review without it. Allowed from every state but `done` and `closed`.",
        security: [{ bearer: ["tasks:write"] }],
        parameters: [taskIdParam],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string", maxLength: 900, description: "Why, for the task and the comment on GitHub." } } } } } },
        responses: {
          "200": response("Closed; the task (state closed) and what happened on GitHub.", "#/components/schemas/TaskClosed"),
          "400": problemResponse("A reason over 900 characters."),
          "404": problemResponse("No such task."),
          "409": problemResponse("The task is already done or closed."),
          "501": notImplemented,
          ...commonErrors,
        },
      },
    },
    "/tasks/{id}/requeue": {
      post: {
        operationId: "requeueTask",
        tags: ["tasks"],
        summary: "Put a task back in the queue, optionally on another lane or model",
        description:
          "A failed task is reopened, a held or blocked one unblocked, a queued one only relabelled; the next run starts over from the base branch. With `lane` or `model` the task's labels change on the way; `\"model\": null` goes back to the lane's default. A running task belongs to the worker that holds it until its lease ends and is refused (409, naming who and until when); close stops a run. A finished task is not requeued: open a new one.",
        security: [{ bearer: ["tasks:write"] }],
        parameters: [taskIdParam],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  lane: laneSchema("The lane to move the task to; omitted keeps its lane."),
                  model: nullable("string", { maxLength: 128, description: "The model to ask the lane for; null goes back to the lane's default; omitted keeps what it has." }),
                },
              },
            },
          },
        },
        responses: {
          "200": response("Requeued; the updated task.", "#/components/schemas/Task"),
          "400": problemResponse("A lane that is not a lane name."),
          "404": problemResponse("No such task."),
          "409": problemResponse("The task is running, done or closed."),
          "501": notImplemented,
          ...commonErrors,
        },
      },
    },
    "/tasks/{id}/release": {
      post: {
        operationId: "releaseTask",
        tags: ["tasks"],
        summary: "Release a task the injection gate held",
        description:
          "A task in state `held` was stopped by the injection gate before a lane ran it: its text (or a note added to its thread) read as instructions aimed at the agent, and the hold's `reason` says what the gate saw. Release lifts the hold for the text as it stands: the task is `queued`, that text is not graded again, and anything added later is. For text a person has read and judged safe. A signed-in person may release anything held; a bot's token must hold `tokens:write`, and a bot never releases a task whose text it wrote any part of: the task itself or a note in its thread. A tripwire in front of the sandbox, not a boundary.",
        security: [{ bearer: ["tokens:write"] }],
        parameters: [taskIdParam],
        responses: {
          "200": response("Released; the updated task (state queued).", "#/components/schemas/Task"),
          "403": problemResponse("A token without tokens:write, or a bot that wrote part of the task's text."),
          "404": problemResponse("No such task."),
          "409": problemResponse("The task is not held."),
          "501": notImplemented,
          ...commonErrors,
        },
      },
    },
    "/events": {
      post: {
        operationId: "logEvent",
        tags: ["events"],
        summary: "Log an external event",
        description: "Appends one `external.*` row to the feed. The actor is always `bot:<token name>` (or `human:<login>` for a signed-in viewer); any actor in the body is ignored.",
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
        description: "Returns the plaintext once. The /access page (signed-in) and `relay token create` in site mode call this. Only the SHA-256 is stored.",
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
  ProjectGitHubStatus: {
    type: "object",
    required: ["repo", "app"],
    properties: {
      repo: { type: ["string", "null"], description: "owner/name, or null when the project has no repository." },
      app: {
        type: "object",
        required: ["configured", "slug", "installed", "installation_id", "install_url"],
        properties: {
          configured: { type: "boolean", description: "This site acts as a GitHub App (environment or /setup/github)." },
          slug: { type: ["string", "null"] },
          installed: { type: "boolean", description: "The App is installed on the repository." },
          installation_id: { type: ["integer", "null"] },
          install_url: { type: "string", format: "uri", description: "Where to install the App; the site's /setup/github when none is configured." },
          error: { type: "string", description: "Why the installation could not be checked; absent when the answer is reliable." },
        },
      },
      webhook: {
        type: "object",
        required: ["org_or_repo_hook_seen", "last_delivery_at"],
        properties: {
          org_or_repo_hook_seen: { type: "boolean", description: "At least one GitHub delivery for the repository has been recorded." },
          last_delivery_at: { type: ["string", "null"], format: "date-time" },
        },
        description: "Omitted when the deployment cannot say (mock mode).",
      },
    },
  },
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
    required: ["id", "channel", "title", "state", "needs", "owner", "created_at"],
    description: "A task as the board has it. What decides where a worker clones and what gets merged (`repo`, `base`, `issue`, `pr`) comes from the task's own text and its hold, never from a label.",
    properties: {
      id: { type: "string", description: "The task's ID on the board." },
      channel: { type: "string", description: "The queue it is in: work/<project>." },
      project: nullable("string"),
      title: { type: "string" },
      body: { type: "string" },
      state: {
        type: "string",
        enum: TASK_STATES,
        description:
          "waiting: a task it needs has not completed. queued: ready for a worker. running: a worker holds it. review: its pull request (or its outputs) waits for a decision. held: the injection gate flagged its text. blocked: held for another reason, such as an eval step looking at the work. done: merged, or its outputs approved. failed: a worker gave up; requeue retries it. closed: called off.",
      },
      board_state: { type: "string", enum: ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"], description: "The board's own state behind `state`." },
      lane: nullable("string"),
      model: nullable("string", { description: "The model the lane is asked for; null is the lane's default." }),
      repo: nullable("string", { description: "owner/name of the repository the work happens in." }),
      base: nullable("string", { description: "The branch to start from instead of the default one." }),
      issue: nullable("object", { description: "The GitHub issue the task answers.", properties: { repo: { type: "string" }, number: { type: "integer" } } }),
      step: nullable("string", { description: "On a step's own task: the step it runs." }),
      evaluates: nullable("string", { description: "On a step's own task: the task whose work it looks at." }),
      branch: nullable("string", { description: "On a step's own task: that work's branch." }),
      pr: nullable("object", { description: "The pull request a task in review (or one an eval is looking at) waits on.", properties: { repo: { type: "string" }, number: { type: "integer" }, url: { type: "string", format: "uri" } } }),
      hold: nullable("object", { description: "Why it is held, for review, held and blocked.", properties: { kind: { type: "string", description: "awaiting_review, gate, awaiting_eval, or the board's own." }, reason: { type: "string" } } }),
      result: nullable("string", { description: "How a completed task ended." }),
      reason: nullable("string", { description: "Why a failed or closed task ended." }),
      needs: { type: "array", items: { type: "string" }, description: "IDs of the tasks that must complete first." },
      claim: nullable("object", { description: "Who holds it and until when.", properties: { actor: { type: "string" }, until: { type: "string", format: "date-time" } } }),
      owner: { type: "string", description: "The principal that made it a task." },
      created_at: { type: "string", format: "date-time" },
      labels: { type: "object", additionalProperties: { type: "string" }, description: "The task's labels (lane, model, and any others). Labels steer; they carry no authority." },
    },
  },
  TaskUsage: {
    type: "object",
    description: "One model call a run posted in the task's thread.",
    properties: {
      kind: { type: "string", enum: ["run", "gate", "media", "step"] },
      lane: { type: "string" },
      tool: { type: "string" },
      model: nullable("string"),
      subscription: nullable("string"),
      billing: { type: "string", enum: ["subscription", "gateway"] },
      tokens_in: { type: "integer" },
      tokens_out: { type: "integer" },
      cache_read: { type: "integer" },
      cache_write: { type: "integer" },
      cost_equiv: { type: "number" },
      duration_ms: { type: "integer" },
      worker: { type: "string" },
      outcome: { type: "string" },
      step: { type: "string" },
    },
  },
  TaskDetail: {
    allOf: [
      { $ref: "#/components/schemas/Task" },
      {
        type: "object",
        properties: {
          usage: { type: "array", items: { $ref: "#/components/schemas/TaskUsage" } },
          notes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, by: { type: "string" }, text: { type: "string" }, at: { type: "string", format: "date-time" } } } },
        },
      },
    ],
  },
  TaskApproved: {
    allOf: [{ $ref: "#/components/schemas/Task" }, { type: "object", properties: { pr_url: nullable("string", { format: "uri" }), merge_sha: nullable("string"), branch_deleted: { type: "boolean" }, opened: { type: "array", items: { type: "string" }, description: "The tasks an approved plan opened, in the order they were opened; absent for any other approval." } } }],
  },
  TaskClosed: {
    allOf: [
      { $ref: "#/components/schemas/Task" },
      {
        type: "object",
        properties: {
          github: { type: "object", properties: { pr_closed: { type: "boolean" }, issue_closed: { type: "boolean" }, error: { type: "string" } } },
          canceled: { type: "array", items: { type: "string" }, description: "Step tasks that were looking at this one, called off with it." },
          to_review: nullable("string", { description: "The work this task was a step of, when closing it sent that work to review." }),
        },
      },
    ],
  },
  TaskList: { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } }, count: { type: "integer" } } },
  TaskCreate: {
    type: "object",
    required: ["project", "title", "lane"],
    properties: {
      project: { type: "string", description: "A project relay knows, registered with a repository." },
      title: { type: "string", maxLength: 200 },
      body: { type: "string", description: "Markdown: what to do and how to tell it is done." },
      lane: laneSchema("The lane that runs the task. A lane no worker serves is refused."),
      model: { type: "string", maxLength: 128, description: "The model the lane should use; the lane's default without it." },
      needs: { type: "array", items: { type: "string" }, description: "IDs of tasks that must complete first; the task waits for them." },
      base: { type: "string", description: "Start from this branch instead of the repository's default one." },
      plan: { type: "boolean", description: "Open it as a planning task: a lane reads the repository and proposes tasks, and none of them is opened until the plan is approved, like any task in review." },
      idempotency_key: { type: "string", maxLength: 200 },
    },
  },
  TaskCreated: { type: "object", required: ["task_id", "created", "task"], properties: { task_id: { type: "string" }, created: { type: "boolean" }, task: { $ref: "#/components/schemas/Task" } } },
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
};
