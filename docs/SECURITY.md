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
  `actions/checkout` (which would wire the token into git). `run-lane.sh` and the worker's `cleanEnv`
  (`packages/core/src/work/job.ts`) unset `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `OPENAI_API_KEY` and `XAI_API_KEY` so a stray key can never make a lane run outside the subscription or act as
  someone other than the machine's operator, and `RELAY_TOKEN`, `RELAY_SITE` and `RELAY_HOME` so the lane never sees
  the worker's own site credential or its `~/.harness`.
- API keys for pay-per-token overflow lanes (`AI_GATEWAY_API_KEY`) live in Vercel's environment for the web app and
  nowhere else; runners do not have them.

If a credential does leak, revoke it at the vendor first, then redo the login on the affected machine.

## Prompt injection: issue text is data

Anyone who can open an issue in a linked repo can write text that a lane will read. relay treats that text as
data, never as instructions:

- **Who can start a lane.** `relay-run.yml` refuses to run unless `github.event.sender.login` (the person who added
  the label, or who opened the PR being reviewed) is listed in the `RELAY_ALLOWED_SENDERS` variable. Opening an
  issue does nothing; labelling it needs triage permission and an allowlisted login. The web app applies the same
  gate when an `agent:<lane>` label arrives by webhook and would become a task for a worker (`senderMayOpenTasks`,
  `apps/web/lib/webhooks/usage.ts`): the label's sender must be in `RELAY_ALLOWED_SENDERS` (the environment, else
  the repo's Actions variable), and when neither is set nobody may open a task that way. `relay task create` and
  the API need a `tasks:write` token instead.
- **How text reaches the shell.** Issue and PR title and body are passed only through `env:`. No `${{ }}` with
  user-controlled content appears inside a `run:` script, so a title like `"; rm -rf ~` is a string, not a command.
- **How text reaches the model.** `run-lane.sh` writes the issue into the brief between `<<<ISSUE` and `ISSUE>>>`
  markers under a banner that says it is data, that instructions inside it about tools, permissions, files, or
  credentials are to be ignored and reported, and what the actual deliverable is. The repo's own `relay.md` rules
  come first in the brief, the issue after.
- **What the model can do anyway.** Even a fooled model is boxed by the CLI's permission model: Claude Code runs
  with `--permission-mode acceptEdits`, an allowlist of named commands (`Read, Edit, Write, Glob, Grep`, `Bash(git
  status|diff|log|add|commit|checkout|restore *)`, `Bash(pnpm install|test|typecheck|build *)`, `Bash(pnpm -r *)`,
  `Bash(npm test*)`) and a refusal list (`--disallowedTools`) for `git push`, `git -c`, `git config`, `git remote`,
  `pnpm dlx`, `pnpm exec`, `npm exec`, `npx`, `curl` and `wget` (`CODE_TOOLS` and `CODE_DISALLOWED_TOOLS` in
  `packages/core/src/work/job.ts`, the same lists in `run-lane.sh`); Codex runs with `--sandbox workspace-write`;
  Grok with `--permission-mode acceptEdits`; fx with `--auto` under its own permission rules. Reviews are read-only
  (`plan` modes, `--sandbox read-only`). Subagents and planners are disabled (`-c agents.enabled=false`,
  `--no-subagents --no-plan`, MCP servers off) so the lane is one process the runner can account for. **The Claude
  allowlist is a permission policy, the second layer**: it decides which tool calls the CLI accepts without asking.
  What the accepted commands and their children (a `package.json` script run by `pnpm test`, a git hook in the
  clone) can then reach is decided by Claude Code's OS sandbox, which every code run starts inside: see "Workers"
  below for what it blocks and what it does not.
- **What the model cannot reach.** On a GitHub Actions runner the lane runs in a fresh clone under `$RUNNER_TEMP` as
  the dedicated `relay` OS user. That user has no SSH keys, no browser profile, no sudo, and no access to your home
  directory. The worktree is deleted after the job. On a worker (`relay work`) the lane runs as the worker's own OS
  user; "Workers" below says what that means and how to set the machine up.
- **What happens to the output.** The lane cannot merge. The lane itself cannot push (`git push` is on the refusal
  list); the worker or runner pushes a `relay/<lane>-<issue>` branch with `--force-with-lease` and opens a PR that a
  human approves; a second lane on a different model reviews it first. **Branch protection on the default branch is
  required**, not optional: the account that pushes is the operator's own `gh` login, so without protection a fooled
  lane that found another way to run `git push` could land on `main`. Require the review and a passing CI run, and
  forbid force pushes.

The usage comment the runner posts is parsed only when the comment author is in `RELAY_ALLOWED_SENDERS`; anyone
else's `{"relay":"step.usage",...}` block is stored as untrusted and excluded from the ledger (`docs/FEED.md`).

## Workers (`relay work`)

A worker is the operator's own machine running the vendor CLIs under the operator's own logins (`docs/WORKERS.md`).
State the facts plainly:

- **The Claude lane's Bash runs inside Claude Code's OS sandbox** (Seatbelt on macOS, bubblewrap and socat on Linux).
  Every code run passes one settings document with `--settings` (`claudeSandboxSettings` in
  `packages/core/src/lanes/sandbox.ts`; `relay lane settings` prints it, `run-lane.sh` uses the same), and
  `--setting-sources ""` makes it the only settings the run sees, so neither the machine's `~/.claude` nor a
  `.claude/settings.json` in the clone can loosen it. Inside it, every Bash command and every child process (git,
  pnpm, a repository's own scripts, a git hook) may write only inside the clone and the pnpm/npm stores, may not read
  `~/.harness`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.grok`, `~/.fx`, `~/.ssh`, `~/.aws`, `~/.config/gh`,
  `~/.netrc`, `~/.npmrc` or `~/.gitconfig`, and may reach only the package registries and GitHub download hosts on the
  network allowlist (`strictAllowlist`; `RELAY_LANE_ALLOWED_DOMAINS` adds hosts) through Claude Code's local proxy.
  `failIfUnavailable` and `allowUnsandboxedCommands: false` mean a machine that cannot sandbox fails the job with a
  message saying what to install; nothing ever falls back to running unsandboxed. Verified on macOS with Claude Code
  2.1.280: `head ~/.gitconfig` and `touch ~/x` fail with "Operation not permitted", `curl` to an unlisted host gets a
  proxy 403 with a `deny network-outbound` violation.
- **What the sandbox does not cover.** It wraps Bash, not the Read/Edit/Write tools, so the same paths are refused
  again with `permissions.deny` rules (`Read(~/.ssh/**)`, `Edit(~/.gitconfig)`, ...) and
  `blockReadsOutsideWorkingDirectories` keeps the Read tool inside the clone. The Claude Code process itself (the
  model call, the login) runs outside the sandbox, which is why the subscription still works. Codex's `--sandbox
  workspace-write` is that vendor's own sandbox; Grok and fx have no OS sandbox, and run under their permission modes
  alone.
- **The permission allowlist (`CODE_TOOLS`, `CODE_DISALLOWED_TOOLS`) is the second layer.** It limits which tool
  calls Claude Code accepts without asking (named git and pnpm subcommands; no push, no package runners, no
  fetchers); the sandbox limits what those commands can reach once they run. Either alone is weaker than both.
- **`relay work --no-sandbox` is the escape hatch, and it is recorded.** The worker logs a warning on start, says
  `sandbox OFF` in its banner line, and registers with the label `sandbox:off`, which the workers page shows. Use it only on a machine where
  the Claude lane's Bash may run with the full rights of the worker's OS user.
- **The lane still runs as the worker's OS user.** The sandbox denies the credential paths above, but any other file
  that user can read, a fooled lane can read; `cleanEnv` strips the API keys and the worker's `RELAY_TOKEN`,
  `RELAY_SITE` and `RELAY_HOME` from the lane's environment, and the clone under `$RELAY_HOME/work` is deleted after
  the job. The next tier is a dedicated OS user or an Apple `container` for the worker (planned as `relay work
  --isolation container`; not built yet).
- **A dedicated OS user or a container for `relay work` is the recommended setup** until that exists. Create a user
  that holds the vendor logins and the `gh` login and nothing else (no SSH keys, no sudo, no browser profile, no access
  to your home directory) and run the worker service as that user, or run the worker in a container whose only
  credentials are those logins. A worker on your daily-use account works and is how `relay setup` gets you started;
  with the sandbox on it is acceptable, without it it should be temporary.
- **Linux prerequisites.** `bubblewrap` and `socat` must be on PATH (`sudo apt install bubblewrap socat`, or `dnf`);
  `relay doctor` has a `sandbox` line that says so. macOS needs nothing extra.
- **Branch protection on the default branch is required.** The worker pushes with the operator's `gh` login; only the
  repository's rules keep a `relay/<lane>-<issue>` branch from becoming `main` without a review.
- Set `RELAY_ALLOWED_SENDERS`: it is what keeps a label added by anyone with triage on a linked repo from becoming a
  job on your machine.

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
- The web app receives only webhooks (verified with `GITHUB_WEBHOOK_SECRET`, the GitHub App's own secret, and
  `VERCEL_WEBHOOK_SECRET`) and API and MCP calls carrying a scoped bearer token. It can never reach a runner; runners
  call it, not the reverse. The one place it makes outbound calls to an address a caller chose, outbound webhooks,
  refuses loopback, link-local, private-network and `.internal`/`.local` targets and requires `https`
  (`validateWebhookUrl`; plain `http` to `localhost` is for development only), so a `webhooks:write` token cannot aim
  the site at its own network.
- The web app's GitHub credential is an App, not a person's token: installation tokens are minted per repository, last
  an hour and live only in memory; the private key sits in `GITHUB_APP_PRIVATE_KEY` or, when the manifest flow created
  the app, sealed in the database under `RELAY_SESSION_SECRET` (`docs/HOSTING.md`).

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

The web app signs people in with GitHub OAuth, with no third-party auth library. Sign-in is allowed for the GitHub
logins listed in `RELAY_ALLOWED_USERS` (comma-separated, case-insensitive), the same identities runners trust as issue
senders. An empty list means nobody can sign in, and the sign-in page says so. A successful sign-in mints a signed
session cookie scoped to the site; nothing else is stored. Agents, runners, and bots never use the browser flow: they
hold scoped bearer tokens, issued by the site's own authorization server after one approval by a signed-in person
("Access for agents" below) or minted by the operator with `relay token create`. There is no self-serve sign-up: every
token traces to a person on the allowlist. Public read of the feed is off in production; the landing, the trust pages,
the docs, the methodology, and the install skill stay public.

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
| `/oauth/*` | the authorization server: `register`, `token`, `device`, `revoke` are for clients; `authorize` asks for the session itself and returns to the consent page after sign-in |
| `/api/v1/info` | the API's own description |
| `/api/v1/*` with an `Authorization: Bearer` header | the token's scopes decide (`apps/web/lib/auth.ts`) |
| `/api/v1/*` `GET` without a bearer when `RELAY_PUBLIC_READ=1` | anonymous read, limited to the public read scopes (`feed:read`, `memory:read`); off by default outside mock mode |
| `/mcp` | its own bearer rules: anyone can `initialize`, `tools/list` and call `relay_get_info` and `relay_get_methodology`; the feed and project read tools answer anonymously when `RELAY_PUBLIC_READ=1`; every other tool needs a bearer with the scope and otherwise returns a tool error naming it |
| `/api/webhooks/*`, `/api/cron/*` | authenticated by `GITHUB_WEBHOOK_SECRET`, `VERCEL_WEBHOOK_SECRET`, `CRON_SECRET` |
| `/api/assets/stream`, `/api/assets/bundle/*`, `/api/assets/upload` | the signed URL is the authentication |
| `/_next/*`, `/icon.svg`, `/opengraph-image` | static output |

| Session required | |
|---|---|
| `/projects`, `/projects/*`, `/usage`, `/workers`, `/assets`, `/assets/*`, `/tokens` (the Access page) | the app pages (and the feed, which is what `/` shows a signed-in viewer) |
| `/activate`, `/setup/*` | approving a device code; the GitHub App setup |
| `/api/feed`, `/api/meters`, `/api/assets/mock/*` | the pages' internal routes |
| `/api/v1/*` without a bearer (and anonymous writes even with `RELAY_PUBLIC_READ=1`) | the signed-in viewer's scopes apply |
| anything not listed | neither: Next answers 404 (Markdown when `Accept: text/markdown`), never a redirect to sign-in, so agents and scanners see a real not-found |

In mock mode (`RELAY_DATA=mock`, or no `DATABASE_URL` with `RELAY_DATA` unset) there is no sign-in: every request
runs as the fake viewer `human:demo`, the header says "demo mode", and `RELAY_REVIEWER` may rename that actor. The
fake session never reaches `/api/v1`: anonymous API callers in mock mode get only what `RELAY_PUBLIC_READ` allows.

### Response headers

`apps/web/next.config.ts` sets on every response: `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Content-Type-Options: nosniff` and `Strict-Transport-Security: max-age=63072000; includeSubDomains`; and on every
route except the asset viewers under `/api/assets/` (which the app frames itself and which carry their own `sandbox`
CSP): `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other site can frame the
app. Writes that a browser makes, the consent decision (`POST /oauth/authorize/decision`), the `/activate` form and
every server action on the Access page, are refused when the browser marks the request `Sec-Fetch-Site: cross-site`
(`apps/web/lib/fetch-site.ts`), a second line behind the `SameSite=Lax` cookie. A `500` from `/api/v1/*` carries a
`correlation_id` and a fixed detail; the message goes to the server log only.

`RELAY_SESSION_SECRET` must be at least 32 characters (`openssl rand -hex 32` gives 64); shorter values are refused
with that hint when signing a session or sealing a setting, so a weak secret cannot be configured by accident.

## Access for agents

Tokens are never copied between people, machines or chats. The web app runs an OAuth 2.1 authorization server
(`/.well-known/oauth-authorization-server`, RFC 8414; the API and MCP server point at it from
`/.well-known/oauth-protected-resource`, RFC 9728, and from every `WWW-Authenticate` challenge) and every grant ends in
one approval by a person who signed in here. The code is `packages/core/src/oauth/server.ts`, framework-free and
covered by `packages/core/test/oauth.test.ts`; the routes under `apps/web/app/oauth` only parse requests.
`docs/INTEGRATIONS.md` is the how-to.

### What a token is

| Kind | Where it lives | Lifetime | Rotation |
|---|---|---|---|
| access token (`rly_…`) | a row in `tokens` named `oauth:<client name>`, SHA-256 only, with `expires_at` and `client_id` | **24 hours** | replaced on every refresh; the old one is revoked when the new one is minted |
| refresh token (`rrt_…`) | `oauth_refresh_tokens`, SHA-256 only, linked to its access token | **90 days** | single use: each refresh issues a new pair and marks the old refresh token used; **using an old one again revokes the whole lineage** (every descendant and their access tokens) and writes `access.revoked` |
| authorization code (`rac_…`) | `oauth_codes`, SHA-256, bound to the client, redirect URI and PKCE challenge | 10 minutes, one use | a second exchange fails and the code stays spent (a wrong `code_verifier` also spends it) |
| device code (`rdc_…`) | `oauth_device_codes`, SHA-256, with the `RLAY-XXXX` user code | 15 minutes, one redemption | polling faster than `interval` answers `slow_down` |
| invite code (`rin_…`) | `invites`, SHA-256, with `uses_left` | what `--expires` says (default 24 h), `--uses` redemptions (default 1) | spent atomically; revocable by id or name |
| operator token (`relay token create`, "Mint a token by hand" on `/tokens`) | the same `tokens` table, no expiry | until revoked | none |

### Who may approve, and how much

Three kinds of actor decide a device request or mint an invite, and the server tells them apart by the actor string:

| Actor | Where | May grant |
|---|---|---|
| a signed-in person (`human:<login>`) | the Access page, `/activate`, the operator's own CLI | anything, including `tokens:write` |
| a credential with `tokens:write` (`bot:oauth:woodhouse`, `token:ci`, the shared `RELAY_MEMORY_TOKEN` as `token:shared`) | `relay_access_approve`, `relay_invite_create` over `/mcp`; `POST /api/v1/access/{code}/approve`, `POST /api/v1/invites`, `POST /api/v1/tokens` | only scopes it holds itself, and never `tokens:write` |
| anything else | nothing: the scope gate refuses before the decision | nothing |

The ceiling is `grantCeilingError` in `packages/core/src/oauth/server.ts`, checked by `decideDeviceRequest` (approve
only; a deny is always allowed), `createInvite` and the by-hand mint at `POST /api/v1/tokens` from the scopes the
caller's grant carries, which the API routes and the MCP server pass explicitly. `human:` actors are only ever
sessions: the shared `RELAY_MEMORY_TOKEN` is `token:shared` over `/mcp` and `/api/v1`, a credential like any other. A refusal is `403` / an MCP tool error reading "a bot can approve only scopes it holds
itself, and never tokens:write; ask a person to approve this one at `<site>/activate`" and changes nothing: the code
stays pending for a person. So a chief-of-staff bot lets other agents in without anyone clicking, but an approved bot
can never widen itself, and `tokens:write` (the scope that makes an approver) is only ever handed out by a person.
Every decision is an `access.granted` or `access.denied` row naming the actor.

The Access page (`/tokens`) shows all of this to the operator: device requests with Approve and Deny (pending,
approved and waiting for the client to poll `/oauth/token`, and the last day's decisions), every token with how it was
issued (OAuth client, invite, by hand) and whether it renews, invites, registered clients, and the by-hand form folded
away at the bottom. Retention: a daily cron (`GET /api/cron/access-expire`, `CRON_SECRET`, 04:30 UTC in
`apps/web/vercel.json`) runs `purgeAccess`: device and authorization codes expired for more than a day, refresh tokens
expired for more than 30 days, and orphan clients (registered on the fly by the device flow, older than a day, with no
tokens, refresh tokens or live codes) are deleted; `access.*` feed rows stay as the audit trail and one `access.purged`
row records the counts when anything went. Any other client can be removed on the Access page once nothing live
depends on it (`removeClient` refuses otherwise).

PKCE `S256` is mandatory and `plain` is refused; `code_challenge_methods_supported` says only `S256`. Redirect URIs are
registered at `POST /oauth/register` and must be `https`, loopback `http` (any port, RFC 8252) or a private-use scheme;
an authorization request whose client or redirect URI does not match is answered on the page, never by redirecting
to the URI the attacker supplied. A `resource` indicator must name this site.

Scopes: a request must say what it is for. An authorization request or a device request without `scope` is
`invalid_scope`, never "everything"; only `POST /oauth/register` defaults (to the whole catalogue as the client's
ceiling) and a refresh without `scope` keeps the grant's own scopes. Scopes may only narrow on refresh.

Client names: the device flow registers a public client per machine from `client_name`, and an invite redemption may
name its client the same way. That name is read aloud on `/activate`, becomes the token's name (`oauth:<name>`) and
appears in feed rows, so it is 1 to 40 characters from letters, digits, space and `. _ @ : + -`
(`CLIENT_NAME_PATTERN`); anything else is `invalid_request` before a client row exists. The `access.requested` summary
is a fixed sentence, `client "<name>" asks for access: approve RLAY-XXXX at <site>/activate`; the requested scopes are
in the payload only, so a client cannot write its own feed line. At most 20 device requests may be pending site-wide
(`MAX_PENDING_DEVICE_REQUESTS`); the 21st is `slow_down` (429) until some are decided or expire. An approval does not
outlive its code: a device code approved but never collected within its 15 minutes is `expired_token` at the token
endpoint, and the row refuses redemption past `expires_at` as well.

### What the consent page shows

`/oauth/authorize` (and `/activate` for device codes) renders, for the signed-in person: the client's registered name
(`relay-cli@studio`, `Grok Bot`), each requested scope with the one-line description from `TOKEN_SCOPE_DESCRIPTIONS`,
where the browser returns afterwards (the redirect URI's host) and, when present, the `resource`, plus the two facts
that matter: the token lasts 24 hours and renews itself for 90 days, and it can be revoked on `/tokens` (Access). Approve and
Deny are plain form posts; the session cookie is `SameSite=Lax`, so a cross-site form cannot approve on the person's
behalf, and the decision route re-validates the client and redirect URI against the registration before issuing
anything the hidden fields could not have changed. A request that was not started by the person should be denied,
and the page says so.

Approvals without a browser go through `POST /api/v1/access/<user_code>/approve` with a `tokens:write` token or the
session; `GET /api/v1/access` lists what is pending. Giving a chat bot `tokens:write` is a deliberate choice: it can
then approve devices and mint invites. Every request and decision is a feed row (`access.requested`, `access.granted`,
`access.denied`, `access.revoked`) with the user code, client and scopes in its payload, so the trail is auditable
and a webhook can relay it.

### Revocation

- `relay token revoke oauth:<client>`, the Access page (`/tokens`), or `DELETE /api/v1/tokens/{id}` revoke an access token at
  once; its refresh token keeps working until it is also revoked, so revoke the refresh token too when the holder is
  not trusted: `POST /oauth/revoke` with `token=<refresh or access token>` (RFC 7009) does both at once.
- `relay invite revoke <id|name>`, Revoke under Invites on the Access page, or `DELETE /api/v1/invites/{id}` stops an
  unredeemed code. Revoking by name (an invite's name, or `relay token revoke oauth:<client>`) is within `tokens:write`
  by design: a holder of that scope may revoke any token or invite, including every token sharing a client name.
  Revocation is the lesser power next to minting, and the scope that can mint is the one that should be able to undo
  it; the audit row (`access.revoked`, `access.invite_revoked`) names who did it.
- Rotating `RELAY_SESSION_SECRET` signs every browser session out and makes the sealed GitHub App key unreadable;
  it does not touch tokens, which live in the database by hash.
- A reused refresh token revokes its lineage automatically; the holder sees `invalid_grant` and must be approved again.

### GitHub App

The web app's GitHub credential is an App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, or the sealed settings the
manifest flow on `/setup/github` wrote; the environment wins). It needs Actions read, Contents read, Deployments read,
Issues write, Metadata read, Pull requests write, and the events issues, issue_comment, pull_request,
pull_request_review, workflow_run, deployment_status. Installation tokens are minted per repository with a nine-minute
RS256 app JWT, cached in memory for their one-hour life and refreshed a minute early. The app's webhook deliveries are
verified with the same HMAC as an organization webhook. `installation` events write `project.github_connected` /
`project.github_disconnected`; a repository is auto-registered as a project only when it already holds a `relay.md`.
Rotation: a new private key in the environment wins immediately; or remove the stored app on `/setup/github` and run
the manifest flow again, then revoke the old key on GitHub.

## Edge rate limits

Per-IP limits on the device, registration and token endpoints and on anonymous API and MCP traffic are enforced by the Vercel WAF in front of the app (`apps/web/infra/firewall.json`, applied as in `docs/HOSTING.md`). They are the shared-store limiter the in-app one is not.
