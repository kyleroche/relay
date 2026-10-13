# Agent readiness contract for the relay site

Target: a 100/100 on [is-agentic.com](https://is-agentic.com) for the hosted site, scanned with `npx is-agentic <domain> --json`. The score is 80 points of Essential checks, 20 of Recommended, and up to 5 bonus; checks that do not apply are excluded and partial results earn proportional credit. The checks come from Ora and follow the [AgentReady standard](https://www.agentready.org/) (find, read, act). This file lists what the site must serve. CI runs the scan after each production deploy and fails on a drop.

## Find

- `/robots.txt`: `User-agent: *` allowed, only low-value paths disallowed, `Sitemap:` line. Explicit groups for `GPTBot`, `ClaudeBot`, `OAI-SearchBot`, `Claude-SearchBot`, `ChatGPT-User`, `Claude-User` that allow.
- `/sitemap.xml` listing every public page.
- `/.well-known/ai-catalog.json`, linked from the homepage `<head>` with `<link rel="ai-catalog">`.
- `<meta name="is-agentic-site-type" content="app">` on every page.
- Brand clarity: `<title>` and H1 say "relay" and what it is in plain words.

## Read

- Every public page server-rendered: at least 500 characters of meaningful text in the initial HTML, an H1, sequential headings, a content ratio above 5%. The feed page renders its first page of events on the server.
- Real links in the homepage HTML to `/info`, the docs, the GitHub repo, and the API docs.
- `/llms.txt` (H1, blockquote summary, H2 link sections) and `/llms-full.txt` (the docs concatenated).
- Markdown mirrors: each docs page also served as `text/markdown` through `Accept` negotiation, with `Vary: Accept`, `406` when nothing acceptable, and `<link rel="alternate" type="text/markdown" href="...">` in the HTML head.
- JSON-LD on the homepage and info page: `SoftwareApplication` plus `Organization`, with the facts repeated in visible text.
- Correct status codes: 404 for unknown paths, never a 200 shell; 429 with `Retry-After` when throttled.
- Fenced code blocks with language tags everywhere.

## Act

- `/openapi.json`: every API operation with an `operationId`, typed responses, errors as RFC 9457 `application/problem+json`, paths under `/api/v1/`, documented rate limits, security scheme with **named scopes** (`feed:read`, `memory:read`, `memory:write`).
- `/.well-known/api-catalog` (RFC 9727) pointing at the OpenAPI description.
- Rate limits: `RateLimit-Policy` and `RateLimit` structured headers on every API response; `429` includes `Retry-After`.
- Public read endpoints that work without credentials when the deploy enables public read: `/api/v1/info`, `/api/v1/feed` (sanitized fields), `/api/v1/projects`. Write endpoints require a bearer token; document self-serve token creation.
- Versioning and deprecation policy at `/docs#versioning`, with RFC 9745 `Deprecation` and `Sunset` headers when used.
- MCP: Streamable HTTP at `/mcp` with public read-only tools (`relay_get_info`, `relay_get_feed`, `relay_get_project`, `relay_get_methodology`) and token-gated memory tools; `/server.json` registry metadata; `/.well-known/mcp/server-card.json`; protected-resource metadata at `/.well-known/oauth-protected-resource` (RFC 9728) describing the bearer scheme and scopes.
- Agent skills: `/.well-known/agent-skills/index.json` listing the `relay` install skill with its SHA-256 digest, served from `skills/relay/SKILL.md` in the repo.
- SDK and CLI: the `relay` CLI on npm with install and first-call examples in the docs.
- Agent onboarding friction: a free tier is the default; nothing is sales-gated; the info page says so in one sentence.

## Not applicable, declared

Payments (x402, UCP, ACP) do not apply to a free tool. WebMCP and NLWeb are optional; skip until the rest scores.

## Verification

```bash
npx is-agentic relay.kyro.house --json | jq '.score, .issues[] | {id, result, recommendation}'
```
