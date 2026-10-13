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
| \`memory:read\` | reading decisions and guidance through MCP |
| \`memory:write\` | capturing decisions through MCP |

Tokens are created with \`pnpm relay token create --scopes feed:read\` on a machine that holds the database connection; the web app never mints tokens. The bearer scheme and scopes are also published at [\`/.well-known/oauth-protected-resource\`](/.well-known/oauth-protected-resource) (RFC 9728).

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

## MCP server

\`${SITE_URL}/mcp\` speaks the MCP Streamable HTTP transport (POST JSON-RPC; stateless). Registry metadata is at [\`/server.json\`](/server.json) and the server card at [\`/.well-known/mcp/server-card.json\`](/.well-known/mcp/server-card.json).

Public read-only tools:

| Tool | What it returns |
|---|---|
| \`relay_get_info\` | the same document as GET /api/v1/info |
| \`relay_get_feed\` | events, with the same filters as the API |
| \`relay_get_project\` | one project with decisions and models |
| \`relay_get_methodology\` | the five rules and a task's life, as text |

Token-gated memory tools (\`relay_capture_decision\`, \`relay_recall\`) answer \`401\` without a bearer token carrying \`memory:write\` or \`memory:read\`.

Claude Code:

\`\`\`bash
claude mcp add --transport http relay ${SITE_URL}/mcp
\`\`\`

## CLI

The \`relay\` CLI lives in the repo (\`pnpm relay --help\`). First calls:

\`\`\`bash
pnpm relay doctor          # what is installed, logged in, reachable
pnpm relay feed --limit 20 # the same feed, in the terminal
pnpm relay usage --window 7d
\`\`\`
`;
}
