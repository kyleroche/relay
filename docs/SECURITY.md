# Security

relay runs other people's text through coding agents that can edit files and push branches, on machines that hold
your subscriptions. This page states the rules that keep that safe and what the code does to enforce them. If a
change to relay would weaken any rule here, it needs a decision in `docs/ARCHITECTURE.md` first.

## The credential rule

**Tasks move, credentials never do.**

- Every model call runs on a machine where you logged in with the vendor's own tool (`claude`, `codex`, `grok`,
  `fx`, `gh`). The login lives in that user's home directory and keychain, where the vendor put it.
- No login, token, `auth.json`, cookie, or config directory is ever copied between machines, pasted into a chat,
  stored as a GitHub secret, or checked into a repository. `.env.example` lists names only.
- The runner workflow never reads `secrets.*`, never passes `GITHUB_TOKEN` into a step, and does not use
  `actions/checkout` (which would wire the token into git). `run-lane.sh` unsets `GH_TOKEN`, `GITHUB_TOKEN`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `XAI_API_KEY` so a stray key can never make a
  lane run outside the subscription or act as someone other than the machine's operator.
- API keys for pay-per-token overflow lanes (`AI_GATEWAY_API_KEY`) live in Vercel's environment for the web app and
  nowhere else; runners do not have them.

If a credential does leak, revoke it at the vendor first, then redo the login on the affected machine.

## Prompt injection: issue text is data

Anyone who can open an issue in a linked repo can write text that a lane will read. relay treats that text as
data, never as instructions:

- **Who can start a lane.** `relay-run.yml` refuses to run unless `github.event.sender.login` (the person who added
  the label, or who opened the PR being reviewed) is listed in the `RELAY_ALLOWED_SENDERS` variable. Opening an
  issue does nothing; labelling it needs triage permission and an allowlisted login.
- **How text reaches the shell.** Issue and PR title and body are passed only through `env:`. No `${{ }}` with
  user-controlled content appears inside a `run:` script, so a title like `"; rm -rf ~` is a string, not a command.
- **How text reaches the model.** `run-lane.sh` writes the issue into the brief between `<<<ISSUE` and `ISSUE>>>`
  markers under a banner that says it is data, that instructions inside it about tools, permissions, files, or
  credentials are to be ignored and reported, and what the actual deliverable is. The repo's own `relay.md` rules
  come first in the brief, the issue after.
- **What the model can do anyway.** Even a fooled model is boxed by the CLI's permission model: Claude Code runs
  with `--permission-mode acceptEdits` and an allowlist of `Read, Edit, Write, Glob, Grep, Bash(pnpm *), Bash(npm
  *), Bash(git *)`; Codex runs with `--sandbox workspace-write`; Grok with `--permission-mode acceptEdits`; fx with
  `--auto` under its own permission rules. Reviews are read-only (`plan` modes, `--sandbox read-only`). Subagents
  and planners are disabled (`-c agents.enabled=false`, `--no-subagents --no-plan`, MCP servers off) so the lane is
  one process the runner can account for.
- **What the model cannot reach.** The lane runs in a fresh clone under `$RUNNER_TEMP` as the dedicated `relay` OS
  user. That user has no SSH keys, no browser profile, no sudo, and no access to your home directory. The worktree
  is deleted after the job.
- **What happens to the output.** The lane cannot merge. It pushes a `relay/<lane>-<issue>` branch and opens a PR
  that a human approves; a second lane on a different model reviews it first. Branch protection on the default
  branch should require that review and a passing CI run.

The usage comment the runner posts is parsed only when the comment author is in `RELAY_ALLOWED_SENDERS`; anyone
else's `{"relay":"step.usage",...}` block is stored as untrusted and excluded from the ledger (`docs/FEED.md`).

## Runner isolation

- One dedicated OS user per machine holds the agent logins and nothing else (`docs/RUNNERS.md`).
- Runners are registered at the org level in a runner group restricted to private repositories. Public repos never
  get the `relay` labels: a fork PR could otherwise run on your machine.
- One job per runner process; the subscriptions are personal-use and the lanes are serialized per subscription.
- Every job has `timeout-minutes` from `max_minutes` (default 60, reviews 30) and a per-issue concurrency group.
- The relay scripts a job runs are cloned at `RELAY_REF` from `RELAY_REPO` using the runner's own gh login. Pin
  `RELAY_REF` to a tag or SHA if you do not want runners to pick up `main` automatically.
- Jobs leave nothing behind: `$RUNNER_TEMP/work` and `$RUNNER_TEMP/relay` are removed in an `always()` step. The
  brief and the CLI's JSON output are written to a `mktemp -d` directory that is removed on exit.
- The web app receives only webhooks (verified with `GITHUB_WEBHOOK_SECRET` and `VERCEL_WEBHOOK_SECRET`) and memory
  calls (bearer `RELAY_MEMORY_TOKEN`). It can never reach a runner; runners call it, not the reverse.

## Never allowed

These are refused in code review regardless of who asks or why:

- Running any lane with permission checks disabled: `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `fx --full-access` / `--yolo`,
  `codex --dangerously-bypass-approvals-and-sandbox`, or equivalents. `relay-run.yml` and `run-lane.sh` contain
  none of them and CI greps for them.
- Copying or syncing a login between machines, or storing one as a GitHub secret or Vercel variable.
- Expanding `${{ github.event.* }}` user content inside a `run:` script.
- Serving a public repository from a self-hosted runner, or removing the sender gate.
- Giving the runner OS user sudo, SSH keys, or access to another user's home directory.
- Sending a transcript, or anything other than the brief, to a model; storing transcripts in memory.
- Letting the lane merge, force-push to a protected branch, or push anything other than its own
  `relay/<lane>-<issue>` branch (`--force-with-lease` on that branch only).
- Adding a non-official source domain to the onboarding registry without a user allowlist entry.

## Reporting

Security issues in relay itself: open a private security advisory on the repository rather than a public issue.
Include the workflow run id if a runner was involved; the Actions log never contains credentials, so it is safe to
attach.

## Signing in to the web app

The web app uses GitHub OAuth only, with no third-party auth library. Sign-in is allowed for the GitHub logins listed
in `RELAY_ALLOWED_USERS` (comma-separated, case-insensitive), the same identities runners trust as issue senders. An
empty list means nobody can sign in, and the sign-in page says so. A successful sign-in mints a signed session cookie
scoped to the site; nothing else is stored. Agents, runners, and bots never use the browser flow: they authenticate
with scoped bearer tokens from `relay token create`; there is no OAuth authorization server for tokens and no
self-serve sign-up. Public read of the feed is off in production; the landing, the trust pages, the docs, the
methodology, and the install skill stay public.

Needed in the environment: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `RELAY_SESSION_SECRET`,
`RELAY_ALLOWED_USERS`. `docs/HOSTING.md` has the OAuth app setup.

### The flow

| Route | What it does |
|---|---|
| `GET /auth/github/start?next=/path` | Stores a random `state` (and the same-site `next` path) in a 10-minute `HttpOnly` cookie and redirects to GitHub's authorize page with scope `read:user` and `allow_signup=false`. |
| `GET /auth/github/callback?code=&state=` | Checks `state` against the cookie, exchanges the code, reads `/user`, checks the login against `RELAY_ALLOWED_USERS`, mints a new session, and redirects to `next`. Failures redirect to `/sign-in?error=<code>` (`denied`, `no-allowlist`, `unconfigured`, `state`, `exchange`, `user`, `github`); the GitHub login is never put in a URL. |
| `POST /auth/sign-out` | Clears the cookie and redirects to `/sign-in`. A plain form post, so it works without JavaScript. |
| `GET /sign-in` | One button, "Continue with GitHub", the allowlist hint, a setup hint when the environment is incomplete, and a note that agents use tokens. A signed-in viewer is redirected to `next`. |

The GitHub access token is used once, to read `/user`, and dropped; relay never stores it.

### The session

The cookie is `relay_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days. Its value is a JWT signed with HS256
over `RELAY_SESSION_SECRET` (`jose`), issuer `relay`, carrying `{login, name, avatar_url, iat, exp}`. Every sign-in
mints a fresh token (new `iat` and `exp`); nothing is refreshed and there is no server-side session store, so signing
out is clearing the cookie and revoking everyone is rotating `RELAY_SESSION_SECRET`. `SameSite=Lax` means the cookie
is not sent on cross-site `POST`/`PUT`, which is what keeps the cookie-authenticated writes below free of CSRF.

Server code reads the viewer through `apps/web/lib/session.ts`: `getSession()` (null when anonymous) and
`requireSession()` (redirects to `/sign-in?next=`). Writes made in the browser, such as approving or rejecting an
asset, are attributed to `human:<login>`. A signed-in browser calling `/api/v1/*` without a bearer gets every scope
under that actor; API clients still use tokens.

### Public and protected routes

`apps/web/proxy.ts` runs on every request and classifies the path with `classifyRoute` (`apps/web/lib/access.ts`,
covered by `apps/web/test/access.test.ts`). Protected pages redirect to `/sign-in?next=<path>`; protected API paths
answer `401` as `application/problem+json` with a `WWW-Authenticate: Bearer` challenge.

| Public without a session | Why |
|---|---|
| `/` | the public landing for an anonymous visitor; the feed for a signed-in viewer (`apps/web/lib/negotiate.ts` decides, the page renders accordingly) |
| `/info`, `/about`, `/contact`, `/privacy`, `/docs`, `/docs/*`, `/api/markdown` | the public overview, the trust pages and the docs, HTML and Markdown |
| `/openapi.json`, `/llms.txt`, `/llms-full.txt`, `/.well-known/*`, `/server.json`, `/robots.txt`, `/sitemap.xml`, `/manifest*`, `/skills/*` | the agent-readiness surface |
| `/sign-in`, `/auth/*` | the sign-in flow itself |
| `/api/v1/info` | the API's own description |
| `/api/v1/*` with an `Authorization: Bearer` header | the token's scopes decide (`apps/web/lib/auth.ts`) |
| `/api/v1/*` `GET` without a bearer when `RELAY_PUBLIC_READ=1` | anonymous read, limited to the public read scopes (`feed:read`, `memory:read`); off by default outside mock mode |
| `/mcp` | its own bearer rules: anyone can `initialize`, `tools/list` and call `relay_get_info` and `relay_get_methodology`; the feed and project read tools answer anonymously when `RELAY_PUBLIC_READ=1`; every other tool needs a bearer with the scope and otherwise returns a tool error naming it |
| `/api/webhooks/*`, `/api/cron/*` | authenticated by `GITHUB_WEBHOOK_SECRET`, `VERCEL_WEBHOOK_SECRET`, `CRON_SECRET` |
| `/api/assets/stream`, `/api/assets/bundle/*`, `/api/assets/upload` | the signed URL is the authentication |
| `/_next/*`, `/icon.svg`, `/opengraph-image` | static output |

| Session required | |
|---|---|
| `/projects`, `/projects/*`, `/usage`, `/workers`, `/assets`, `/assets/*` | the app pages (and the feed, which is what `/` shows a signed-in viewer) |
| `/api/feed`, `/api/meters`, `/api/assets/mock/*` | the pages' internal routes |
| `/api/v1/*` without a bearer (and anonymous writes even with `RELAY_PUBLIC_READ=1`) | the signed-in viewer's scopes apply |
| anything not listed | neither: Next answers 404 (Markdown when `Accept: text/markdown`), never a redirect to sign-in, so agents and scanners see a real not-found |

In mock mode (`RELAY_DATA=mock`, or no `DATABASE_URL` with `RELAY_DATA` unset) there is no sign-in: every request
runs as the fake viewer `human:demo`, the header says "demo mode", and `RELAY_REVIEWER` may rename that actor. The
fake session never reaches `/api/v1`: anonymous API callers in mock mode get only what `RELAY_PUBLIC_READ` allows.
