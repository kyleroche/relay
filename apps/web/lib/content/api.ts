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

### Access

Nobody copies tokens. This site runs an OAuth 2.1 authorization server ([metadata](/.well-known/oauth-authorization-server), RFC 8414; the API and MCP server name it in [\`/.well-known/oauth-protected-resource\`](/.well-known/oauth-protected-resource), RFC 9728, and in every \`WWW-Authenticate\` challenge). Three ways in, each ending in one approval by a signed-in person:

| You are | Do this | Approval |
|---|---|---|
| an MCP client or app with a browser | \`POST /oauth/register\` (RFC 7591, public client), then the authorization code flow with PKCE S256 at \`/oauth/authorize\` and \`/oauth/token\` | the consent page shows the client name and each scope; approve or deny |
| a CLI or a headless bot | \`POST /oauth/device\` (RFC 8628) returns a code like \`RLAY-4F7Q\`; poll \`/oauth/token\` with \`grant_type=urn:ietf:params:oauth:grant-type:device_code\` | the person opens [\`/activate\`](/activate), or a bot calls \`POST /api/v1/access/RLAY-4F7Q/approve\` from a chat reply; \`relay setup --site <url>\` does all of this for a machine |
| anything the operator trusts in advance | \`relay invite create --for <name> --scopes <a,b>\` prints a one-time code; redeem it with \`grant_type=urn:relay:invite\` or \`relay setup --site <url> --invite <code>\` | none: the invite is the approval |

Access tokens last **24 hours** and are rows in the same \`tokens\` table as operator-minted ones, named \`oauth:<client name>\`, so every scope check and \`relay token ls|revoke\` applies to them. Refresh tokens last **90 days** and rotate on every use; reusing an old one revokes the whole lineage. Revoke either kind at \`POST /oauth/revoke\` (\`token=…\`), on the [Access page](/tokens), or with \`relay token revoke\`. That page also lists pending device requests (Approve and Deny), approvals waiting for the client to poll, invites and registered clients. Every request and decision is an \`access.*\` row in the feed, so a webhook on \`access.requested\` lets a chat bot relay the approval. The [connect guide](/docs/integrations) walks through each case.

\`GET /api/v1/whoami\` (and the \`relay_whoami\` MCP tool) tells any credential what it is: name, scopes, expiry, source.

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
| \`tasks:write\` | POST /api/v1/tasks, POST /api/v1/tasks/{id}/approve, POST /api/v1/tasks/{id}/request-changes, relay_task_create, relay_task_approve, relay_task_request_changes |
| \`events:write\` | POST /api/v1/events, relay_event_log (external.* kinds only; actor is always bot:<token name>) |
| \`projects:write\` | PUT /api/v1/projects/{slug}, /digests, /summary (relay link in site mode) |
| \`webhooks:write\` | /api/v1/webhooks: list, add, remove, test |
| \`tokens:write\` | /api/v1/tokens: list, mint, revoke (relay token in site mode); /api/v1/access and /api/v1/invites; relay_access_list, relay_access_approve, relay_invite_create, relay_invite_revoke. A token (not a signed-in person) may approve or invite only to scopes it holds itself, and never tokens:write (403) |

The operator can also mint tokens by hand, under "Mint a token by hand" on the [Access page](/tokens) while signed in or with the CLI (locally against the database, or in site mode against \`POST /api/v1/tokens\`), and invites the same way:

\`\`\`bash
pnpm relay token create --name ci-runner --scopes feed:read,assets:write   # prints the token once
pnpm relay token ls                                                        # OAuth tokens show as oauth:<client>
pnpm relay token revoke oauth:grok-bot
pnpm relay invite create --for woodhouse --scopes tasks:read,tasks:write,events:write --expires 24h --uses 1
\`\`\`

Only the SHA-256 of a token is stored (\`tokens\` table). A deployment without a database can set \`RELAY_API_TOKENS\` instead (\`token:scope,scope;token2:scope\`), and \`RELAY_MEMORY_TOKEN\` is one shared secret that grants every scope (attributed \`token:shared\`: a credential, so it cannot approve or mint \`tokens:write\`); neither has an expiry. The bearer and \`oauth2\` schemes and their scopes are described in [\`/openapi.json\`](/openapi.json) (\`securitySchemes\`) and in the [MCP server card](/.well-known/mcp/server-card.json). A request without a usable token gets \`401\` with \`WWW-Authenticate: Bearer realm="relay", scope="<scope>", resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource"\`.

### OAuth endpoints

| Endpoint | Does |
|---|---|
| \`GET /.well-known/oauth-authorization-server\` | RFC 8414 metadata: endpoints, \`scopes_supported\`, grant types, \`code_challenge_methods_supported: ["S256"]\` |
| \`GET /.well-known/oauth-protected-resource\` | RFC 9728: this site as the resource, \`authorization_servers: ["${SITE_URL}"]\` |
| \`POST /oauth/register\` | RFC 7591: \`{"client_name", "redirect_uris", "grant_types", "token_endpoint_auth_method": "none"}\` → \`client_id\` (public) or \`client_secret\` once (\`client_secret_post\`) |
| \`GET /oauth/authorize\` | the consent page (needs the relay session): \`response_type=code\`, \`client_id\`, \`redirect_uri\`, \`scope\`, \`state\`, \`code_challenge\`, \`code_challenge_method=S256\`, optional \`resource\` |
| \`POST /oauth/token\` | \`authorization_code\` (+ \`code_verifier\`), \`refresh_token\` (rotated), \`urn:ietf:params:oauth:grant-type:device_code\`, \`urn:relay:invite\` (\`invite=<code>\`, optional \`client_name\`) |
| \`POST /oauth/device\` | \`client_id\` or \`client_name\`, \`scope\` → \`device_code\`, \`user_code\`, \`verification_uri\` (\`/activate\`), \`verification_uri_complete\`, \`interval\`, \`expires_in\` (15 min) |
| \`POST /oauth/revoke\` | RFC 7009: \`token=<access or refresh token>\` |

Form-encoded or JSON bodies are accepted; errors are RFC 6749 \`{"error", "error_description"}\`.

\`\`\`bash
# headless bot: ask, show the code, poll
curl -s -X POST ${SITE_URL}/oauth/device -d client_name=my-bot -d "scope=tasks:read tasks:write events:write"
# → {"device_code":"rdc_…","user_code":"RLAY-4F7Q","verification_uri":"${SITE_URL}/activate",…,"interval":5}
curl -s -X POST ${SITE_URL}/oauth/token -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code=rdc_…
# → {"error":"authorization_pending"} until approved, then {"access_token":"rly_…","refresh_token":"rrt_…","expires_in":86400,…}
\`\`\`

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
| \`GET /api/v1/tasks/{owner}/{repo}%23{n}\` (\`getTask\`) | \`tasks:read\` | one task: \`state\` (queued, claimed, running, review, done, failed), \`runner\`, \`pr_url\`, \`preview_url\` and \`preview_state\`, \`run_summary\`, \`usage\`, \`review\`, \`merged_at\`, last \`summary\` |
| \`POST /api/v1/tasks/{owner}/{repo}%23{n}/approve\` (\`approveTask\`) | \`tasks:write\` | squash-merge the PR of a task in review, delete its branch, write \`task.approved\` (the task is done); a bot may not approve a PR its own lane produced, and GitHub's refusal comes back as 502 with \`task.merge_failed\` |
| \`POST /api/v1/tasks/{owner}/{repo}%23{n}/request-changes\` (\`requestTaskChanges\`) | \`tasks:write\` | \`{"note"}\`: comment on the PR, write \`task.changes_requested\`, queue the task again; the next run gets the note in its brief |
| \`POST /api/v1/events\` (\`logEvent\`) | \`events:write\` | \`{"kind":"external.<x>","project","summary","url","cost_equiv","source"}\`; the actor is the token's |
| \`GET /api/v1/usage\` (\`getUsage\`) | \`feed:read\` | per-subscription totals since \`since\` |
| \`GET /api/v1/projects/{slug}/decisions\` (\`listProjectDecisions\`) | \`memory:read\` | decision history, \`current=1\` for open ones |
| \`PUT /api/v1/projects/{slug}\`, \`/digests\`, \`/summary\` | \`projects:write\` | what \`relay link\` uploads in site mode |
| \`GET\`, \`POST /api/v1/webhooks\`; \`GET\`, \`DELETE /api/v1/webhooks/{id}\`; \`POST /api/v1/webhooks/{id}/test\` | \`webhooks:write\` | outbound webhooks; the signing secret is returned once on create; [payload and signature](/docs/feed#outbound-webhooks) |
| \`GET\`, \`POST /api/v1/tokens\`; \`DELETE /api/v1/tokens/{id}\` | \`tokens:write\` | list, mint (plaintext once), revoke |
| \`GET /api/v1/whoami\` (\`whoami\`) | any credential | the caller's token name, scopes, expiry and source |
| \`GET /api/v1/access\`; \`POST /api/v1/access/{user_code}/approve\` | \`tokens:write\` | pending device requests; approve (or \`{"decision":"deny"}\`) one by its code |
| \`GET\`, \`POST /api/v1/invites\`; \`DELETE /api/v1/invites/{id}\` | \`tokens:write\` | invite codes: list (never the code), mint (code once), revoke |

\`\`\`bash
curl -s -X POST ${SITE_URL}/api/v1/tasks -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"project":"site","title":"Add dark mode to pricing","lane":"codex","priority":"high","idempotency_key":"conv-91:1"}'
curl -s "${SITE_URL}/api/v1/tasks?state=review" -H "Authorization: Bearer $TOKEN" | jq '.tasks[] | {id, state, pr_url, preview_url, run_summary}'
curl -s -X POST "${SITE_URL}/api/v1/tasks/acme/site%2342/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "${SITE_URL}/api/v1/tasks/acme/site%2342/request-changes" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"note":"The toggle has no focus ring; match the one on /settings."}'
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
| \`relay_task_get\`, \`relay_task_list\` | \`tasks:read\` | derived task state (queued, claimed, running, review, done, failed) with runner, PR, preview URL, run summary, usage and the review decision |
| \`relay_task_approve\`, \`relay_task_request_changes\` | \`tasks:write\` | approve a task in review (relay squash-merges the PR and deletes the branch) or send it back with a note (PR comment, task queued again, note in the next brief). A bot never approves a PR its own lane produced |
| \`relay_event_log\` | \`events:write\` | log an \`external.*\` event; the actor is always \`bot:<token name>\` |
| \`relay_whoami\` | public | this connection's token name, scopes, expiry and source; anonymous callers are told where the authorization server is |
| \`relay_webhook_subscribe\`, \`relay_webhook_unsubscribe\` | \`webhooks:write\` | register an outbound webhook (the signing secret is returned once) and remove one |
| \`relay_access_list\`, \`relay_access_approve\` | \`tokens:write\` | pending device requests (and approvals awaiting the poll); approve or deny one by its \`RLAY-XXXX\` code, the same decision the Access page makes: how a chief-of-staff bot lets other agents in. A bot can approve only scopes it holds itself, never \`tokens:write\` |
| \`relay_invite_create\`, \`relay_invite_revoke\` | \`tokens:write\` | mint an invite code (returned once, with the \`relay setup --site … --invite\` line) for an agent trusted in advance; revoke one by id or name. The same ceiling applies |

Anyone can connect: \`initialize\` and \`tools/list\` need no token, and \`relay_get_info\` and \`relay_get_methodology\` always answer anonymously. With public read enabled (\`RELAY_PUBLIC_READ=1\`, the demo default) the \`feed:read\` and \`memory:read\` tools answer without a token too. Every other call without the right scope returns an MCP tool error (\`isError: true\`) naming the missing scope, not an HTTP error; only a bearer token the server does not recognise gets HTTP \`401\`. Every response carries the same \`RateLimit\` headers as the API.

Claude Code (the client discovers the authorization server from the 401 challenge and runs the consent flow; no token to paste):

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

A machine without the database can use this site instead: \`pnpm relay setup --site ${SITE_URL}\` prints a code, you approve it at [/activate](/activate) (or with \`--invite <code>\` from \`relay invite create\`, no approval), and the CLI stores a token that renews itself. From then on the memory, feed, token, invite, task and webhook commands and the session hooks call \`/api/v1\` and \`/mcp\` here; \`relay link\` still digests locally and uploads ([Memory, "Site mode"](/docs/memory)). \`relay doctor\` shows the token's name, source and expiry.
`;
}
