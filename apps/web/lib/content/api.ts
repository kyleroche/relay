import { SITE_URL } from "@/lib/data";
import { RATE_LIMIT } from "@/lib/api";

/** The API and MCP guide at /docs/api, generated so it cannot drift from the handlers. */
export function apiMarkdown(): string {
  return `# API and MCP

relay exposes the same read model three ways: this site, a small JSON API under \`/api/v1/\`, and an MCP server at \`/mcp\`. All three read through one data interface; none of them call a model.

## Base URL and versioning

Base URL: \`${SITE_URL}/api/v1\`. The version is in the path. Changes follow the [versioning and deprecation policy](/docs/versioning): additive changes ship in place, breaking changes get a new path segment, and retired operations announce themselves with \`Deprecation\` and \`Sunset\` headers (RFC 9745) before they go.

The OpenAPI 3.1 description is at [\`/openapi.json\`](/openapi.json) and is listed in [\`/.well-known/api-catalog\`](/.well-known/api-catalog) (RFC 9727).

## Authentication and scopes

Read endpoints work without credentials when the deploy enables public read (\`RELAY_PUBLIC_READ=1\`, the default for demo data). Otherwise, and for every write, send a bearer token:

\`\`\`http
Authorization: Bearer <token>
\`\`\`

Scopes are named and granted per token:

| Scope | Grants |
|---|---|
| \`feed:read\` | GET /api/v1/feed, /api/v1/projects, relay_get_feed, relay_get_project |
| \`memory:read\` | relay_recall, relay_brief, relay_guidance, relay_feed, relay_project |
| \`memory:write\` | relay_decide, relay_prefer |
| \`assets:read\` | GET /api/v1/assets, GET /api/v1/assets/{id}, relay_asset_list, relay_asset_get |
| \`assets:write\` | POST /api/v1/assets, finalize, publish, relay_asset_request_upload, relay_asset_finalize |
| \`assets:review\` | PUT /api/v1/assets/{id}/review |
| \`tasks:read\` | GET /api/v1/tasks, GET /api/v1/tasks/{owner}/{repo}%23{n}, relay_task_get, relay_task_list |
| \`tasks:write\` | POST /api/v1/tasks, relay_task_create |
| \`events:write\` | POST /api/v1/events, relay_event_log (external.* kinds only; actor is always bot:<token name>) |
| \`projects:write\` | PUT /api/v1/projects/{slug}, /digests, /summary (relay link in site mode) |
| \`webhooks:write\` | /api/v1/webhooks: list, add, remove, test |
| \`tokens:write\` | /api/v1/tokens: list, mint, revoke (relay token in site mode) |

Tokens are minted on the [tokens page](/tokens) while signed in (the first one for a new site), or with the CLI, locally against the database or in site mode against \`POST /api/v1/tokens\`:

\`\`\`bash
pnpm relay token create --name ci-runner --scopes feed:read,assets:write   # prints the token once
pnpm relay token ls
pnpm relay token revoke ci-runner
\`\`\`

Only the SHA-256 of a token is stored (\`tokens\` table). A deployment without a database can set \`RELAY_API_TOKENS\` instead (\`token:scope,scope;token2:scope\`), and \`RELAY_MEMORY_TOKEN\` is one shared secret that grants every scope. There is no OAuth authorization server and no self-serve sign-up: the bearer scheme and its scopes are described in [\`/openapi.json\`](/openapi.json) (\`securitySchemes.bearer\`) and in the [MCP server card](/.well-known/mcp/server-card.json), and a token comes from the operator ([contact](/contact)). A request without a usable token gets \`401\` with a \`WWW-Authenticate: Bearer realm="relay", scope="<scope>"\` challenge.

## Rate limits

Every API response carries structured rate-limit headers (IETF RateLimit header fields):

\`\`\`http
RateLimit-Policy: "${RATE_LIMIT.policyName}";q=${RATE_LIMIT.limit};w=${RATE_LIMIT.windowSeconds}
RateLimit: "${RATE_LIMIT.policyName}";r=57;t=42
\`\`\`

The default policy is ${RATE_LIMIT.limit} requests per ${RATE_LIMIT.windowSeconds} seconds per client. Over the limit you get \`429 Too Many Requests\` with a \`Retry-After\` header and a problem document.

## Errors

Errors are \`application/problem+json\` (RFC 9457):

\`\`\`json
{
  "type": "${SITE_URL}/docs/api#errors",
  "title": "Not Found",
  "status": 404,
  "detail": "No project with slug 'nope'.",
  "instance": "/api/v1/projects/nope"
}
\`\`\`

Unknown paths under \`/api/v1/\` return 404 in this shape, never an HTML shell.

## Operations

### GET /api/v1/info

\`operationId: getInfo\`. Name, version, description, the five rules, data mode, and links to every machine-readable surface.

\`\`\`bash
curl -s ${SITE_URL}/api/v1/info | jq .
\`\`\`

### GET /api/v1/feed

\`operationId: listFeed\`. Events newest first, sanitized: \`payload\` and \`dedupe_key\` are omitted. Query: \`project\`, \`kind\`, \`actor\`, \`lane\`, \`limit\` (1-200, default 50), \`before\` and \`after\` (ISO timestamps) for paging.

\`\`\`bash
curl -s "${SITE_URL}/api/v1/feed?kind=step.usage&limit=5" | jq '.events[] | {ts, actor, model, cost_equiv}'
\`\`\`

### GET /api/v1/projects

\`operationId: listProjects\`. Every linked project with last activity, open issues, decision count and digest coverage.

### GET /api/v1/projects/{slug}

\`operationId: getProject\`. One project with its current decisions, models and recent events.

### Assets

The asset library ([docs/ASSETS.md](/docs/assets)): media agents produce, stored privately, versioned, reviewed. Every view URL is signed and expires after an hour. Uploads need a database and a store (\`RELAY_DATA=db\`); the demo deployment answers \`501\` to uploads and serves mock assets.

| Operation | Scope | Does |
|---|---|---|
| \`GET /api/v1/assets\` (\`listAssets\`) | \`assets:read\` | pending first, then newest; filter by \`project\`, \`status\`, \`kind\`, \`issue\`, \`pr\` |
| \`POST /api/v1/assets\` (\`createAsset\`) | \`assets:write\` | multipart \`file\` + metadata ingests in one call; JSON \`{"presign": true, "project", "filename"}\` reserves an id and returns a one-time upload URL |
| \`POST /api/v1/assets/{id}/finalize\` (\`finalizeAsset\`) | \`assets:write\` | after the presigned PUT: probe, thumbnail, create the row |
| \`GET /api/v1/assets/{id}\` (\`getAsset\`) | \`assets:read\` | metadata, the version chain, signed \`url\`, \`thumb_url\`, \`bundle_url\` |
| \`PUT /api/v1/assets/{id}/review\` (\`reviewAsset\`) | \`assets:review\` | \`{"decision": "approved" \\| "rejected", "note"}\`; a rejection note becomes a project decision and, with a GitHub token, reopens the issue |
| \`POST /api/v1/assets/{id}/publish\` (\`publishAsset\`) | \`assets:write\` | copy to the public Blob store and record a permanent URL (\`501\` without one) |

One-call upload:

\`\`\`bash
curl -X POST ${SITE_URL}/api/v1/assets -H "Authorization: Bearer $TOKEN" \\
  -F file=@render.png -F project=atlas-site -F issue=118 -F title="Pricing hero" -F tags=ux,pricing
\`\`\`

Presigned upload (bytes go straight to storage, never through the app or a model):

\`\`\`bash
curl -s -X POST ${SITE_URL}/api/v1/assets -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"presign":true,"project":"atlas-site","filename":"walkthrough.mp4","issue":73}' > presign.json
curl -X PUT "$(jq -r .upload_url presign.json)" -H "content-type: video/mp4" --data-binary @walkthrough.mp4
curl -X POST "$(jq -r .finalize_url presign.json)" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d "$(jq .finalize_body presign.json)"
\`\`\`

Review:

\`\`\`bash
curl -X PUT ${SITE_URL}/api/v1/assets/<id>/review -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"decision":"rejected","note":"Keep one accent hue; lower the chroma to match the light theme."}'
\`\`\`

### Tasks, external events, webhooks

The integration surface for an external bot ([Integrations](/docs/integrations)):

| Operation | Scope | Does |
|---|---|---|
| \`POST /api/v1/tasks\` (\`createTask\`) | \`tasks:write\` | \`{"project","title","body","lane","priority","idempotency_key"}\`: opens the GitHub issue with \`agent:<lane>\`, records the task, writes \`issue.opened\` and \`task.created\`; 201, or 200 for a repeated key |
| \`GET /api/v1/tasks\` (\`listTasks\`) | \`tasks:read\` | tasks newest first with derived state; \`project\`, \`state\`, \`limit\` |
| \`GET /api/v1/tasks/{owner}/{repo}%23{n}\` (\`getTask\`) | \`tasks:read\` | one task: \`state\` (queued, running, review, done, failed), \`runner\`, \`pr_url\`, last \`summary\` |
| \`POST /api/v1/events\` (\`logEvent\`) | \`events:write\` | \`{"kind":"external.<x>","project","summary","url","cost_equiv","source"}\`; the actor is the token's |
| \`GET /api/v1/usage\` (\`getUsage\`) | \`feed:read\` | per-subscription totals since \`since\` |
| \`GET /api/v1/projects/{slug}/decisions\` (\`listProjectDecisions\`) | \`memory:read\` | decision history, \`current=1\` for open ones |
| \`PUT /api/v1/projects/{slug}\`, \`/digests\`, \`/summary\` | \`projects:write\` | what \`relay link\` uploads in site mode |
| \`GET\`, \`POST /api/v1/webhooks\`; \`GET\`, \`DELETE /api/v1/webhooks/{id}\`; \`POST /api/v1/webhooks/{id}/test\` | \`webhooks:write\` | outbound webhooks; the signing secret is returned once on create; [payload and signature](/docs/feed#outbound-webhooks) |
| \`GET\`, \`POST /api/v1/tokens\`; \`DELETE /api/v1/tokens/{id}\` | \`tokens:write\` | list, mint (plaintext once), revoke |

\`\`\`bash
curl -s -X POST ${SITE_URL}/api/v1/tasks -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"project":"site","title":"Add dark mode to pricing","lane":"codex","priority":"high","idempotency_key":"conv-91:1"}'
curl -s "${SITE_URL}/api/v1/tasks?state=review" -H "Authorization: Bearer $TOKEN" | jq '.tasks[] | {id, state, pr_url, summary}'
\`\`\`

## MCP server

\`${SITE_URL}/mcp\` speaks the MCP Streamable HTTP transport (POST JSON-RPC; stateless). It is the same server the CLIs talk to over stdio (\`relay-mcp\`): one tool set, gated by the scopes your token carries. Registry metadata is at [\`/server.json\`](/server.json) and the server card at [\`/.well-known/mcp/server-card.json\`](/.well-known/mcp/server-card.json).

| Tool | Scope | What it does |
|---|---|---|
| \`relay_get_info\` | public | the same document as GET /api/v1/info |
| \`relay_get_methodology\` | public | the five rules and a task's life, as text |
| \`relay_get_feed\` | \`feed:read\` | events, with the same filters as the API |
| \`relay_get_project\` | \`feed:read\` | one project with decisions, models and recent events |
| \`relay_recall\` | \`memory:read\` | decisions and preferences relevant to a query |
| \`relay_brief\` | \`memory:read\` | the compiled brief for a project and intent |
| \`relay_guidance\` | \`memory:read\` | official vendor guidance for a model |
| \`relay_feed\`, \`relay_project\` | \`memory:read\` | compact text forms for a CLI session |
| \`relay_decide\`, \`relay_prefer\` | \`memory:write\` | record a decision; set a preference |
| \`relay_asset_list\`, \`relay_asset_get\` | \`assets:read\` | the library, and one asset with signed URLs |
| \`relay_asset_request_upload\`, \`relay_asset_finalize\` | \`assets:write\` | reserve an id and upload URL; turn the upload into an asset |
| \`relay_task_create\` | \`tasks:write\` | open a task: GitHub issue with the lane label; idempotent on \`idempotency_key\` |
| \`relay_task_get\`, \`relay_task_list\` | \`tasks:read\` | derived task state (queued, running, review, done, failed) with runner, PR and last summary |
| \`relay_event_log\` | \`events:write\` | log an \`external.*\` event; the actor is always \`bot:<token name>\` |

Anyone can connect: \`initialize\` and \`tools/list\` need no token, and \`relay_get_info\` and \`relay_get_methodology\` always answer anonymously. With public read enabled (\`RELAY_PUBLIC_READ=1\`, the demo default) the \`feed:read\` and \`memory:read\` tools answer without a token too. Every other call without the right scope returns an MCP tool error (\`isError: true\`) naming the missing scope, not an HTTP error; only a bearer token the server does not recognise gets HTTP \`401\`. Every response carries the same \`RateLimit\` headers as the API.

Claude Code:

\`\`\`bash
claude mcp add --transport http relay ${SITE_URL}/mcp
\`\`\`

## CLI

The \`relay\` CLI lives in the repo (\`pnpm relay --help\`). First calls:

\`\`\`bash
pnpm relay doctor          # what is installed, logged in, reachable; which mode (local or site)
pnpm relay feed -n 20      # the same feed, in the terminal
pnpm relay usage --days 7
\`\`\`

A machine without the database can use this site instead: mint a token on [/tokens](/tokens), then
\`pnpm relay setup --site ${SITE_URL} --token <token>\`. From then on the memory, feed, token, task and webhook commands and the session hooks call \`/api/v1\` and \`/mcp\` here; \`relay link\` still digests locally and uploads ([Memory, "Site mode"](/docs/memory)).
`;
}
