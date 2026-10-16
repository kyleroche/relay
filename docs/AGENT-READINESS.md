# Agent readiness contract for the relay site

Target: a 100/100 on [is-agentic.com](https://is-agentic.com) for the hosted site, scanned with `npx is-agentic <domain> --json`. The score is 80 points of Essential checks, 20 of Recommended, and up to 5 bonus; checks that do not apply are excluded and partial results earn proportional credit. The checks come from Ora and follow the [AgentReady standard](https://www.agentready.org/) (find, read, act). This file lists what the site must serve. CI runs the scan after each production deploy and fails on a drop.

## Find

- `/robots.txt`: `User-agent: *` allowed, only low-value paths disallowed, `Sitemap:` line. Explicit groups for `GPTBot`, `ClaudeBot`, `OAI-SearchBot`, `Claude-SearchBot`, `ChatGPT-User`, `Claude-User` that allow.
- `/sitemap.xml` listing every public page and only those: the pages that need a session would only redirect a crawler to sign-in, so they are left out.
- `/.well-known/ai-catalog.json`, linked from the homepage `<head>` with `<link rel="ai-catalog">`.
- `<meta name="is-agentic-site-type" content="app">` on every page.
- Brand clarity: `<title>` and H1 say "relay" and what it is in plain words.

## Read

- The homepage is public. An anonymous `GET /` gets the landing (what relay is, the five rules, the task flow, install, accounts, who makes it) server-rendered with no redirect; a signed-in viewer, and every request in mock mode, gets the feed at the same path. `/info` renders the same landing for everyone with canonical `/`. The scanner is anonymous, so what it scores is the landing (`apps/web/lib/negotiate.ts` makes the call; `proxy.ts` and `app/page.tsx` apply it).
- Every public page server-rendered: at least 500 characters of meaningful text in the initial HTML, one H1, sequential headings, a content ratio above 5%. The feed page renders its first page of events on the server.
- Real links in the homepage HTML to the docs, the GitHub repo, the API docs, and the trust pages.
- Trust pages at `/about` (what relay is, who makes it, open source under Apache-2.0), `/contact` (GitHub issues, the operator's address when `RELAY_CONTACT_EMAIL` is set, security reporting via `docs/SECURITY.md`) and `/privacy` (one session cookie after GitHub sign-in, no analytics or trackers, the feed and assets belong to the operator, how to delete), each at least 500 characters, linked from the footer and the landing, in the sitemap, with Markdown mirrors.
- `/llms.txt` (H1, blockquote summary, H2 link sections) and `/llms-full.txt` (the docs concatenated).
- Markdown mirrors: the anonymous homepage, `/info`, the trust pages and each docs page also served as `text/markdown` through `Accept` negotiation, with `Vary: Accept` (`Vary: Accept, Cookie` on `/`), `406` when nothing acceptable, and `<link rel="alternate" type="text/markdown" href="...">` in the HTML head. A signed-in `/` is the feed and stays HTML. Known limit: the Markdown responses carry `Vary: Accept`, but the HTML page responses cannot, because Next 16's app-page runtime overwrites `Vary` after middleware runs (`next/dist/build/templates/app-page-runtime.js`, `res.setHeader('Vary', …)`); revisit when Next merges it. The rewrite to `/api/markdown` passes the page in the `x-relay-markdown-path` request header because a rewrite's query string does not reach the handler.
- JSON-LD on the homepage: `SoftwareApplication` (name, description, applicationCategory, operatingSystem, offers price 0, license URL, codeRepository, author) plus `Organization` with `url`, `founder` and a `contactPoint` (contactType "technical support", url = the GitHub issues URL, email from `RELAY_CONTACT_EMAIL` when set), with the facts repeated in visible text. No postal address: relay has none, and the site does not invent one.
- `noindex` only on `/sign-in`; the auth routes are redirects. Every other page is indexable.
- Correct status codes: 404 for unknown paths, never a 200 shell and never a redirect to sign-in; the 404 page has helpful text and links, and `Accept: text/markdown` on an unknown path gets a `text/markdown` 404 body. 429 with `Retry-After` when throttled.
- Fenced code blocks with language tags everywhere.

## Act

- `/openapi.json`: every API operation with an `operationId`, typed responses, errors as RFC 9457 `application/problem+json`, paths under `/api/v1/`, documented rate limits, an `http` `bearer` security scheme with **named scopes** (`feed:read`, `memory:read`, `memory:write`, `assets:*`) and the issuance command (`relay token create`).
- No OAuth claims. There is no authorization server, so nothing on the site says "OAuth" or links an RFC 9728 protected-resource document (RFC 9728 is for finding an authorization server, which does not exist here). The catalog, the OpenAPI description, the server card and the `WWW-Authenticate` challenges describe a plain bearer token issued by the operator with `relay token create`.
- `/.well-known/api-catalog` (RFC 9727) pointing at the OpenAPI description and the MCP server card.
- Rate limits: `RateLimit-Policy` and `RateLimit` structured headers on every API response and every `/mcp` response (including refusals); `429` includes `Retry-After`.
- Public read endpoints that work without credentials when the deploy enables public read: `/api/v1/info`, `/api/v1/feed` (sanitized fields), `/api/v1/projects`. Write endpoints require a bearer token; document self-serve token creation.
- Versioning and deprecation policy at `/docs#versioning`, with RFC 9745 `Deprecation` and `Sunset` headers when used.
- MCP: Streamable HTTP at `/mcp`. Anyone can `initialize` and `tools/list`; `relay_get_info` and `relay_get_methodology` answer without a token always; `relay_get_feed` and `relay_get_project` answer anonymously only when `RELAY_PUBLIC_READ=1`; the memory and asset tools need a bearer with the matching scope. A call without the scope is an MCP tool error (`isError: true`) naming the scope, not an HTTP 401; only an unrecognised bearer is a 401. `/server.json` registry metadata and `/.well-known/mcp/server-card.json` say the same.
- Agent skills: `/.well-known/agent-skills/index.json` listing the `relay` install skill with its SHA-256 digest, served from `skills/relay/SKILL.md` in the repo.
- SDK and CLI: the `relay` CLI on npm with install and first-call examples in the docs.
- Agent onboarding friction: a free tier is the default; nothing is sales-gated; the info page says so in one sentence.

## Not applicable, declared

Payments (x402, UCP, ACP) do not apply to a free tool. WebMCP and NLWeb are optional; skip until the rest scores.

## Verification

```bash
npx is-agentic relay.kyro.house --json | jq '.score, .issues[] | {id, result, recommendation}'
```
