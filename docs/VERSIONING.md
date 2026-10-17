# Versioning and deprecation

This policy covers everything relay serves to other programs: the JSON API under `/api/v1/`, the MCP server at `/mcp`, the OpenAPI description, the well-known files, and the `@relay/core` package.

## Versions

- The API version is a path segment: `/api/v1/`. A new major version gets a new segment and the old one keeps working through its sunset date.
- Additive changes ship in place without a version bump: new optional query parameters, new response fields, new event kinds, new MCP tools.
- Breaking changes never ship in place. A field is never renamed, retyped or removed within a version; an operation is never given different semantics.
- MCP tools follow the same rule. A tool's input schema only gains optional fields; a tool that must change is added under a new name and the old one is deprecated.
- `@relay/core` follows semantic versioning. The `events` table is append-only and its columns are never dropped; new columns are nullable or defaulted.

## Deprecation

When an operation, tool, field or file is scheduled for removal:

1. It is announced in the changelog and in `docs/AGENT-READINESS.md` at least 90 days before removal.
2. Every response from a deprecated operation carries RFC 9745 headers:

```http
Deprecation: @1767225600
Sunset: Sat, 04 Apr 2026 00:00:00 GMT
Link: </docs/versioning>; rel="deprecation"; type="text/html"
```

   `Deprecation` is the instant the deprecation took effect; `Sunset` (RFC 8594) is when the operation stops answering. The `Link` points at this policy and at the replacement where one exists.

3. The OpenAPI description marks the operation `deprecated: true` and names the replacement in its description.
4. After the sunset date the operation returns `410 Gone` as `application/problem+json` for at least 30 days, then 404.

## What is stable now

The following are covered by this policy as of the first public release: `GET /api/v1/info`, `GET /api/v1/feed`, `GET /api/v1/projects`, `GET /api/v1/projects/{slug}`, the MCP tools `relay_get_info`, `relay_get_feed`, `relay_get_project`, `relay_get_methodology`, and the files `/openapi.json`, `/llms.txt`, `/llms-full.txt`, `/.well-known/ai-catalog.json`, `/.well-known/api-catalog`, `/.well-known/mcp/server-card.json`, `/.well-known/agent-skills/index.json` and `/server.json`.

`/.well-known/oauth-protected-resource` was served before the first public release, removed when relay had no authorization server to point at, and is back now that it has one: `/.well-known/oauth-authorization-server` (RFC 8414), `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/device` and `/oauth/revoke` are the authorization server, and the RFC 9728 document names it. These, `GET /api/v1/whoami` and the `relay_whoami` tool join the stable list with this release; the `urn:relay:invite` grant is relay's own and documented in `docs/INTEGRATIONS.md`.

Write endpoints and the token-gated MCP memory tools are pre-release: they may change without the notice period until they are listed here.
