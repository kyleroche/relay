# Hosting the web app

The web app (`apps/web`) is a Next.js app that shows the board, the feed, projects and usage meters, serves the HTTP
memory server and the task API, and ingests webhooks from GitHub and Vercel. Tasks and workers are not in its
database: it reads and writes them on the team's Vercel Board, as its own deployment (`docs/ARCHITECTURE.md`, "The
site and the board"). It holds no vendor credentials. It deploys to Vercel with a Neon Postgres database.

## 1. Vercel project

1. Push relay to GitHub (private is fine).
2. Vercel dashboard → Add New → Project → import the relay repository.
3. Set **Root Directory** to `apps/web`, framework Next.js, Node 24. Leave build and install commands at their
   defaults; the monorepo uses pnpm and Vercel picks the version from `packageManager` in `package.json`.
4. Deploy once; it will fail on the database until step 2 is done, which is expected.

Or from the CLI: `vercel link` in the repo root, then `vercel --cwd apps/web`.

## 2. Neon Postgres via the Marketplace

1. In the Vercel project → Storage → Create Database → **Neon** (Marketplace). Pick the region closest to where
   the app runs (same region as the Vercel functions).
2. Connect it to the project for all environments. Vercel writes `DATABASE_URL` (and Neon's `POSTGRES_*` aliases)
   into the project's environment variables automatically.
3. The schema is `packages/core/src/db/schema.sql`; migrations run on first start and from `pnpm relay init`. It
   needs the `vector` extension, which Neon enables on `CREATE EXTENSION vector` without any plan change.
4. Locally, leave `DATABASE_URL` unset and the app runs on embedded PGlite. `vercel env pull` fetches the Neon URL
   into `.env.local` if you want to run against production data from your machine; do not commit that file.

## 2b. The team's Vercel Board

Tasks and workers live on the board of a Vercel team (`docs/WORKERS.md`, "The board"), and the site reaches it with
its deployment's own identity, so there is no board credential to set.

1. **The project must be on the team that owns the board.** A deployment of another team cannot read it, and every
   page that shows tasks or workers says so in place of the board.
2. **Introduce the site and the workers.** From a machine whose Vercel login manages the board, run
   `relay setup --board --site-project <the Vercel project's name>`: it grants the project's production deployment
   the queues under `work/` by name, adds that deployment (`vercel:project:<id>:production`) to the machine's
   `board.from` so its workers take the tasks the site opens, and prints the `RELAY_BOARD_FROM` line for step 3
   (`docs/WORKERS.md`, "A machine becomes a worker"). The same command registers relay's schemas, once per team.
   The grant does not make the site a manager of the queues: Vercel's board gives a deployment no `manage`. The site
   approves, sends back, releases, requeues and closes the tasks opened through it, which it owns, and shows the
   command that settles a task opened from a machine (`docs/ARCHITECTURE.md`, "The site and the board").
3. **Tell the site whose blocks to believe.** Set `RELAY_BOARD_FROM` on the project to the worker logins, as
   comma-separated actor IDs. The site counts a usage or run block only from its own deployment and those logins;
   without it the feed shows tasks opening, being claimed and closing, and no run outcomes or usage. Set it before
   the workers run: usage from a login that was not yet listed is not counted, and is not backfilled later.
4. **Another board than the team's default** is `RELAY_BOARD_TEAM` and `RELAY_BOARD_NAME`, the same names a worker
   reads.

The board wakes the deployment at `https://<site>/api/board` for its two watchers, the ledger and the brief; the
route needs no configuration and no session, since the board verifies its own wake-ups.

Locally the site uses your `vercel login`, or the board at `BOARD_URL` (`npx vb serve` prints it). Nothing wakes a
local server, so the pages that show the feed sync it themselves, at most every 15 seconds. With `RELAY_DATA=mock`
the site runs on an in-memory demo board and needs no login.

## 3. Environment variables

`.env.example` at the repo root and `apps/web/.env.example` list the names the app reads. Set each one in Vercel → Project → Settings →
Environment Variables (Production and Preview), or with `vercel env add NAME`.

| Name | From | Used by |
|---|---|---|
| `DATABASE_URL` | Neon integration (automatic) | everything that touches Postgres |
| `RELAY_BOARD_FROM` | the worker logins, as comma-separated actor IDs; `relay setup --board --site-project` prints the line | whose `relay-usage@1` and `relay-run@1` blocks the site believes, besides its own (step 2b) |
| `RELAY_BOARD_TEAM`, `RELAY_BOARD_NAME` | optional: a team ID or slug, a named board | a board other than the default one of the project's own team |
| `BOARD_URL` | local only: what `npx vb serve` prints | a local board in place of the team's |
| `AI_GATEWAY_API_KEY` | Vercel → AI Gateway → API keys | embeddings for memory search; the optional overflow lane |
| `GITHUB_WEBHOOK_SECRET` | you generate it (`openssl rand -hex 32`) | verifies `X-Hub-Signature-256` on the GitHub webhook |
| `VERCEL_WEBHOOK_SECRET` | shown once when the Vercel webhook is created | verifies `x-vercel-signature` on the Vercel webhook |
| `RELAY_PUBLIC_URL` | the deployed URL, e.g. `https://relay.example.com` | absolute links in the feed, signed asset URLs, GitHub comments |
| `RELAY_MEMORY_TOKEN` | you generate it | one shared bearer token that grants every scope at `/mcp` and `/api/v1` |
| `RELAY_API_TOKENS` | optional, `token:scope,scope;token2:scope` | static scoped tokens for deployments without the `tokens` table |
| `RELAY_DATA` | `db` or `mock` | data mode; unset means `db` when `DATABASE_URL` is set, else `mock` |
| `RELAY_PUBLIC_READ` | `1` or `0` | whether `/api/v1` reads and the MCP feed/project read tools answer without a token (default: on in mock mode only); `relay_get_info`, `relay_get_methodology`, `initialize` and `tools/list` are always public |
| `RELAY_CONTACT_EMAIL` | optional, an address you answer | published on `/contact` and in the Organization JSON-LD `contactPoint`; unset means the site names no address and points at GitHub issues |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob (private store) | asset bytes; unset means a local folder, which does not survive on Vercel |
| `BLOB_PUBLIC_READ_WRITE_TOKEN` | a second, public Blob store | `relay asset publish` and `POST /assets/{id}/publish` |
| `RELAY_ASSET_SIGNING_KEY` | `openssl rand -hex 32` | signs local view/upload URLs and HTML bundle URLs |
| `CRON_SECRET` | `openssl rand -hex 32` | Vercel sends it as a bearer to `/api/cron/assets-expire` (the daily retention sweep in `apps/web/vercel.json`) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | the GitHub App (step 4b), or leave unset and use the manifest flow on `/setup/github` | merging a task's pull request on approval and deleting its branch, the comment on a pull request sent back, closing a closed task's pull request and issue, asset comments, the `relay.md` probe on install, as the app; installation tokens per repository, in memory only. The environment wins over a stored app |
| `GITHUB_APP_SLUG` | the app's URL slug (optional with the environment pair) | the install link on `/setup/github` |
| `GITHUB_APP_TOKEN` or `GITHUB_TOKEN` | a fine-grained token with contents, pull requests and issues write on the managed repos | the fallback when no app is configured, for the same merges, comments and closes |
| `RELAY_ALLOWED_SENDERS` | comma-separated logins | whose `agent:<lane>` label on an issue opens a task on the board (else the repository's Actions variable of the same name; with neither, nobody) |
| `RELAY_GATEWAY_TOKEN` | optional: the model gateway's key (Vercel AI Gateway → API keys). Make it a key of its own, with a budget (step 8c) | paid sandbox runs (step 8c), experimental. Without it no run is offered or started. The sandbox's firewall adds it to requests for the gateway's coding endpoint, from any process in the sandbox; it cannot be read there, and it can be used there |
| `RELAY_GATEWAY_URL` | optional: an https URL | the gateway endpoint Claude Code is pointed at in a paid run; unset means Vercel AI Gateway's Claude Code endpoint |
| `RELAY_CLOUD_AFTER_MINUTES` | optional: a positive number | how long a task waits in the queue before a paid run is offered; unset means 15 |
| `RELAY_CLOUD_MAX_CAP_USD` | optional: a positive number | the most a person may approve for one paid run, in US dollars; unset means 10, and never above 1000 |
| `RELAY_LEAD_URL` | optional: the origin of relay's lead (step 8b) | when set, the site wakes the lead about a task that failed, was held at the gate or reached review; unset means no lead |
| `RELAY_LEAD_WAKE_SECRET` | with `RELAY_LEAD_URL`: at least 32 characters (`openssl rand -hex 32`), the same value as on the lead's project | signs each wake-up (HMAC-SHA256) so the lead knows the site sent it; used for nothing else. Unset or shorter means no wake-up is sent |
| `GITHUB_OAUTH_CLIENT_ID` | the GitHub OAuth app (step 4) | browser sign-in |
| `GITHUB_OAUTH_CLIENT_SECRET` | the same OAuth app, generated once | browser sign-in; the code exchange |
| `RELAY_SESSION_SECRET` | `openssl rand -hex 32` (at least 32 characters; shorter is refused) | signs the `relay_session` cookie (HS256) and seals the GitHub App key the manifest flow stores; rotating it signs everyone out and makes a stored app unreadable |
| `RELAY_ALLOWED_USERS` | comma-separated GitHub logins, e.g. `kyle,octocat` | who may sign in (case-insensitive; empty means nobody) |
| `RELAY_REVIEWER` | optional actor, mock mode only | who the demo's approve/reject clicks are attributed to (default `human:demo`); with a database the signed-in user is the reviewer |
| `RELAY_PLAN_METERS` | optional JSON | a manual override for the header's plan meters, per meter id: `[{"id","label","subscription","percentUsed","resetsAt"}]`. The workers' own readings (Claude Code's 5-hour and weekly rate limits, saved by relay's status line on each machine) are kept by each worker in its message on the board (`docs/WORKERS.md`, "Plan meters"), and the site reads the freshest one when this variable is unset. Set `max-week-fable` here to show a third Claude bar; nothing documented reports a per-model meter |

Tokens for API clients come from the site's authorization server (`docs/INTEGRATIONS.md`: OAuth with consent for MCP
clients, the device flow for CLIs and bots approved on `/activate`, invite codes from `relay invite create`) or from
the CLI by hand: `pnpm relay token create --name ci --scopes feed:read,assets:write` stores a hash in the `tokens`
table and prints the token once. The app checks the `tokens` table when it runs on a database, then
`RELAY_API_TOKENS`, then `RELAY_MEMORY_TOKEN`.

Secrets are values, never files: nothing in the repo contains one, and `.env.example` stays names-only.

### Monorepo root directory

The app lives in `apps/web` of a pnpm workspace. Vercel builds it with **Root Directory** set to `apps/web` (step 1
above) and the workspace packages resolve because `next.config.ts` sets `outputFileTracingRoot` to the repo root and
transpiles `@relay/core` and `@relay/mcp` from source. `apps/web/vercel.json` holds the cron schedule and applies
because it sits in that root directory; a `vercel.json` at the repository root would be ignored for this project. The
SQL migrations under `packages/core/src/db/migrations` are traced into the function bundle so the schema applies on
first request (`apps/web/lib/db.ts`).

Locally, `RELAY_DATA=db` with no `DATABASE_URL` runs the app on the same embedded PGlite file the CLI uses
(`$RELAY_HOME/relay.pglite`, override with `RELAY_PGLITE_FILE`), so `pnpm relay init`, `relay asset put` and the web
app share one database on one machine. Do not run the CLI and the dev server against one PGlite file at the same
time; PGlite holds a single-process lock.

## 4. GitHub OAuth app (sign-in)

The web app signs people in with GitHub and nothing else (`docs/SECURITY.md`, "Signing in to the web app"). It needs
one OAuth app, owned by you or your organization:

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App** (or Organization → Settings → Developer
   settings → OAuth Apps).
2. Application name: `relay` (anything). Homepage URL: `https://<site>`. **Authorization callback URL:
   `https://<site>/auth/github/callback`**, where `<site>` is the host in `RELAY_PUBLIC_URL`. Leave device flow off.
3. Register, then **Generate a new client secret**. Put the client id in `GITHUB_OAUTH_CLIENT_ID` and the secret in
   `GITHUB_OAUTH_CLIENT_SECRET`.
4. Generate `RELAY_SESSION_SECRET` (`openssl rand -hex 32`) and set `RELAY_ALLOWED_USERS` to the GitHub logins that
   may sign in. Redeploy.

The app asks for the `read:user` scope only and keeps nothing from GitHub but the login, display name and avatar URL
in the session cookie. Preview deployments need their own OAuth app (GitHub allows one callback URL per app) or
Vercel's deployment protection in front of them; for a local dev server, make a second app with callback
`http://localhost:3000/auth/github/callback` and put its values in `apps/web/.env.local`. `GITHUB_SERVER_URL` and
`GITHUB_API_URL` point the flow at a GitHub Enterprise Server; unset they are github.com.

Routes the proxy leaves public (info, docs, the well-known files, OpenAPI, llms.txt, the install skill, `/mcp`, the
webhooks, the cron, signed asset URLs, and `/api/v1` with a bearer) and the ones that need a session are tabled in
`docs/SECURITY.md`. Mock mode has no sign-in: it runs as the fake viewer `human:demo`.

## 4b. GitHub App (merges, comments, issue intake)

The web app acts on GitHub as an App installed once per organization, so no person's token is stored anywhere. It
is the credential an approval on the site merges with (a worker and the CLI use the machine's own `gh` login), and
its deliveries are how an `agent:<lane>` label on an issue opens a task and how a merge on GitHub completes one. Two
ways to set it up; the environment always wins over a stored app, which is also how you rotate.

**One click (fresh deployment).** Sign in, open `https://<site>/setup/github`, optionally name the organization that
should own the app, and press Create. The page posts a GitHub App manifest (name `relay-<host>`, permissions Actions
read, Contents write (approve squash-merges the PR and deletes its branch), Deployments read, Issues write, Metadata read, Pull requests write; events issues,
pull_request, pull_request_review, workflow_run, deployment_status; webhook `https://<site>/api/webhooks/github`) to
`https://github.com/settings/apps/new` (or the organization's page). GitHub asks you to confirm and redirects to
`/setup/github/callback`, which exchanges the one-time code (`POST /app-manifests/{code}/conversions`) and stores the
app id and slug plain and the private key, webhook secret and client secret sealed with `RELAY_SESSION_SECRET` in the
`settings` table. Then press Install and pick the repositories. The app's webhook is verified with its own secret, so
`GITHUB_WEBHOOK_SECRET` is not needed for app deliveries (keep it for an organization webhook you still run).

**By hand.** Create the app under GitHub → Settings → Developer settings → GitHub Apps with the same permissions and
events, webhook URL `https://<site>/api/webhooks/github` and a webhook secret you generate; generate a private key; set
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the whole PEM; `\n`-escaped on one line or base64 is fine), `GITHUB_APP_SLUG`
and `GITHUB_WEBHOOK_SECRET`; redeploy; install the app on the repositories.

**Rotate.** Generate a new private key on GitHub and put it in `GITHUB_APP_PRIVATE_KEY` (wins at once), or remove the
stored app on `/setup/github` and run the manifest flow again; then revoke the old key on GitHub. Rotating
`RELAY_SESSION_SECRET` makes a stored key unreadable, which the setup page reports as "not configured".

Without an app, `GITHUB_APP_TOKEN` or `GITHUB_TOKEN` (a fine-grained personal token) still works as before.

**What `relay link` checks.** The App is the path a linked repo's events take to the site, so in site mode `relay link`
ends with an `events` stage that asks the site (`GET /api/v1/projects/{slug}/github`) whether the App is installed on
the repo. Installed: `ok events GitHub App installed on <repo> (installation <id>)`. Not installed: a `warn` line with
the App's install link (one install covers every repo you pick) and a final `left:` line naming it as the one thing
left to do; until then the repo's issues, labels, PRs and previews never reach the site. No App configured at all: the
line points the operator at `/setup/github`. `relay doctor` repeats the warning for every linked project still missing
the App (five lines, then `+N more`). The check is advice: it never fails the link, and `--no-events` skips it.

## 5. GitHub webhook (organization level)

With the GitHub App installed you need no separate webhook: the app delivers the same events to
`https://<site>/api/webhooks/github`, plus `installation` and `installation_repositories`, which become
`project.github_connected` rows (and register a project when the repository holds a `relay.md`). The organization
webhook is the fallback for repositories the app is not installed on; `relay link` does not check for it (the
`webhook` object of `GET /api/v1/projects/{slug}/github` only reports whether any GitHub delivery for the repo has
arrived and when the last one did). Organization → Settings → Webhooks → Add webhook:

- Payload URL: `https://<RELAY_PUBLIC_URL>/api/webhooks/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: *Let me select individual events* → Issues, Pull requests, Pull request reviews,
  Workflow jobs, Workflow runs, Pushes.

`docs/FEED.md` lists which event becomes which feed row. The handler is idempotent on the `X-GitHub-Delivery`
header (`events.dedupe_key`), so GitHub's redeliveries are safe to use when debugging.

If you cannot create org webhooks, add the same webhook to each linked repo; `relay link` prints the URL and
events to use.

## 6. Vercel webhook

For the projects whose previews you want in the feed (the repos the lanes work on, deployed on Vercel):

- Vercel → Team Settings → Webhooks → Create: URL `https://<RELAY_PUBLIC_URL>/api/webhooks/vercel`, events
  `deployment.created`, `deployment.succeeded`, `deployment.error`, `deployment.canceled`; select the projects.
- Copy the secret Vercel shows into `VERCEL_WEBHOOK_SECRET` and redeploy the web app.

Each `deployment.succeeded` for a `relay/` branch becomes a `preview.ready` event linked to the PR.

## 7. Custom domain

Vercel → Project → Settings → Domains → Add `relay.example.com`, then create the DNS record Vercel shows (a CNAME
to `cname.vercel-dns.com`, or Vercel nameservers for the whole zone). Certificates are issued automatically. After
the domain resolves, set `RELAY_PUBLIC_URL` to it, update the two webhook URLs above, and the OAuth app's callback URL.

The app pages are behind the GitHub sign-in (step 4) in production, since the feed shows your repos' issue titles and
spend; the info page, the docs and the agent-readiness files stay public. Enable Vercel Authentication (Deployment
Protection) for previews, which have no OAuth app of their own.

## 7b. Firewall rate limits

The authorization server's public endpoints and the anonymous API surface get per-IP rate limits from the Vercel WAF (Pro plan or above), so a stranger cannot spam device requests, registrations or token polls across function instances. The rules live in `apps/web/infra/firewall.json`:

| Paths | Limit per IP | Why |
|---|---|---|
| `POST /oauth/device`, `POST /oauth/register` | 10 per minute | one request per machine or bot is the normal rate |
| `POST /oauth/token` | 60 per minute | device polling is 12 per minute; refreshes are rarer |
| `/api/v1/*`, `/mcp` without an `Authorization` header | 60 per minute | anonymous discovery and probing; bearer callers are not limited here |

Apply or update them with the CLI from `apps/web` (the project must be linked):

```bash
vercel api "/v1/security/firewall/config?projectId=<project id>&teamId=<team id>" --method PUT --input infra/firewall.json
```

The firewall answers an over-limit request with 403 before it reaches the app. Attack challenge mode and BotID stay off: they exist to stop automated clients, which is what this site serves. The in-app limiter (`apps/web/lib/api.ts`) is per instance and only a backstop.

## 8. Publishing the CLI to npm

The `relay` command ships as `@kyleroche/relay` (`packages/cli`, built with `tsup` into `dist/`: the CLI, the stdio
MCP server, the hook scripts, the SQL migrations, the shipped steps with their checks, the Griptape Nodes shim and the
container files). `.github/workflows/release.yml`
publishes it when a `v*` tag is pushed whose version matches `packages/cli/package.json`; it typechecks, tests, runs
`scripts/check-package.sh` (pack, install into an empty directory, run `relay` and `relay-mcp`), then
`pnpm publish --provenance --access public`.

Authentication is npm **trusted publishing** (OIDC), so no npm token is stored in GitHub. npm only lets you
configure a trusted publisher on a package that already exists, so the very first version is published by hand:

1. From a machine with `npm login` done: `pnpm --filter @kyleroche/relay build && cd packages/cli && pnpm publish --access public`.
2. On npmjs.com → the package → Settings → **Trusted Publisher** → GitHub Actions: organization or user `kyleroche`,
   repository `relay`, workflow filename `release.yml`, environment left empty. Save.
3. Optional but recommended, same page: set publishing access to *Require two-factor authentication and disallow
   tokens*, so only the workflow (and 2FA-protected humans) can publish.
4. Release: bump `version` in `packages/cli/package.json`, commit, `git tag v<version> && git push --tags`. The job
   presents its GitHub identity to npm; npm matches it against the trusted publisher and accepts the publish with a
   provenance attestation shown on the package page.

The published manifest lists the runtime dependencies (`pg`, `@electric-sql/pglite`, the MCP SDK, `commander`, and
so on; `sharp` optional) and no workspace packages: `@relay/core` and `@relay/mcp` are bundled into `dist/relay.js`.
Node 24 or newer is required (`engines`). A `relay setup` run from the installed package records
`<package>/dist/hooks/*.mjs` and `<package>/dist/relay-mcp.js` in the CLIs' configs, so `npm update -g` keeps them
valid; a checkout records its `packages/cli/hooks` and `packages/mcp/bin` paths instead.

Releases are staged, not published, by the workflow: pushing a `v<version>` tag (matching `packages/cli/package.json`) runs the checks and `npm stage publish` through the package's trusted publisher, then a maintainer approves the staged version on npmjs.com (Staged packages, 2FA) or with `npm stage approve`. Nothing goes live without that approval, and no npm token exists anywhere.

## 8b. The lead (optional)

The lead (`apps/lead`) is a separate Vercel project on the same team as the site, with its own environment, token
and deployment steps: `apps/lead/README.md`. It reaches this site only through `/mcp` with a scoped token minted on
the Access page (`tasks:read`, `tasks:write`, `memory:read`, `feed:read`, `events:write`; never `tasks:decide`,
`tokens:write` or `memory:write`). Its model calls are billed per token through Vercel AI Gateway to the team that
owns its project. The site runs without it.

To have the site wake the lead, make one secret of at least 32 characters (`openssl rand -hex 32`), set it as
`RELAY_LEAD_WAKE_SECRET` on both projects, set `RELAY_LEAD_URL` on the site's project to the lead's origin (https),
and deploy both. The site then posts to the lead's `/relay/wake` when a task failed, was held at the gate or reached
review, with a timestamp and an HMAC-SHA256 signature over the timestamp and the body. It sends no token: the site
deployment's own Vercel OIDC token is its identity on the team's board and goes nowhere else. With the URL set and no
usable secret the site sends nothing and says why once in its log; a lead without the secret answers 503. The
`lead` watcher exists only where `RELAY_LEAD_URL` is set, and only the board wakes it: a site the board does not
wake (local development, a board at `BOARD_URL`) wakes no lead.

The wake-up carries no Vercel credential, so Vercel's Deployment Protection does not let it through. `RELAY_LEAD_URL`
must be an address of the lead that protection leaves open, normally its production domain; behind protection the
wake-up gets Vercel's 401 and is dropped (`apps/lead/README.md`, "Deploy").

## 8c. Paid sandbox runs (optional)

A queued task that none of your workers can take can be offered a run in a Vercel Sandbox on paid credits. Nothing
starts or spends until a signed-in person approves a cap for that one task (`docs/PROFILE.md`, "Paid sandbox runs").

This is experimental: no paid run has been made against a real sandbox or a real gateway. It stays off unless
`RELAY_GATEWAY_TOKEN` is set. Before you set it, read `docs/SECURITY.md`, "What a paid run's lane can reach": the
lane can run any code in the sandbox, and that code can use what the sandbox's firewall signs.

The deployment needs:

| Need | Why |
|---|---|
| `RELAY_GATEWAY_TOKEN` | the model gateway's key; without it the offer is never shown. Give it a budget (below) |
| the site's GitHub App (step 4b), installed on the task's repository | the site mints an installation token for that one repository for each start, with `contents: write`, `pull_requests: write` and `metadata: read` only; `GITHUB_TOKEN` alone is not enough |
| a rule on the default branch of each repository that may run this way | a pull request with at least 1 approval, "Require approval of the most recent reviewable push" on, and relay's GitHub App not on the bypass list. The site asks GitHub before a run is approved and before it starts, and refuses without it (below) |
| nothing for the board | the sandbox reaches it as the site's deployment, under the worker's profile, with its rights narrowed to the task's own queue (`work/<project>`) and the workers channel |
| nothing for the sandbox itself on Vercel | it is created with the deployment's own OIDC token; locally, `vercel env pull` provides one |

**A budget on the gateway's key.** The cap a person approves is kept by relay's own model calls. The firewall adds
this key to any request for the gateway's coding endpoint, whichever process in the sandbox sent it, so code a
fooled lane runs there can spend past the cap. What it can spend at most is the budget on the key. Make a key for
paid runs alone and give it one:

```bash
vercel ai-gateway api-keys create --name relay-paid-runs --amount 50 --refresh-period monthly
```

Or add one to a key you have (`vercel ai-gateway budgets set api-key relay-paid-runs --amount 50 --refresh-period
monthly`), or use the key's Edit dialog in the dashboard. Three things to know, from Vercel's own documentation: a
budget is at least 1 US dollar; it is a soft cap, checked when a request starts, so the request that crosses it
still completes; and a new budget may not count requests for its first minute or two. A key with no budget of its
own, and no default budget for the team's keys, is limited only by the team's budget, if there is one. relay does not make a key per run: Vercel's API for that takes a person's
Vercel access token, which the deployment does not hold and should not.

**The rule on the default branch.** In the repository: Settings, Rules, Rulesets, New branch ruleset, target the
default branch, "Require a pull request before merging" with 1 required approval and "Require approval of the most
recent reviewable push", bypass list empty. Why each part is needed is in `docs/PROFILE.md`, "The branch rule". Two
consequences:

- relay's own Approve merges as the same GitHub App, so on that repository it merges a pull request only after a
  person approved it on GitHub. Do not put the App on the bypass list to get around that: every paid run's token
  would bypass the rule too, and the site refuses a run when GitHub says the App may bypass.
- Classic branch protection does not count unless the App may read its settings (the Administration permission,
  which relay's App does not ask for). Use a ruleset.

`RELAY_CLOUD_AFTER_MINUTES` and `RELAY_CLOUD_MAX_CAP_USD` set when a run is offered and the most a person may
approve. A project opts out with `"cloud": "never"` in its profile.

The sandbox installs `@kyleroche/relay` from npm at the version in `packages/cli/package.json` the site was built
with, and Claude Code at the one version named in `packages/core/src/cloud/plan.ts` (`CLOUD_CLAUDE_CODE_VERSION`).
The relay version must be published (section 8), with `relay work --task` and `--billing` in it, before a paid run
can work. Nothing here has been run against a real sandbox or a real gateway yet.

## 9. Checklist

- [ ] Optional, experimental: `RELAY_GATEWAY_TOKEN` set to a key with a budget, the deployed CLI version published
      and a ruleset on each repository's default branch (step 8c), if paid sandbox runs are wanted;
      `RELAY_LEAD_URL` set, and the same `RELAY_LEAD_WAKE_SECRET` on the site and on the lead, if the lead is deployed

- [ ] Project imported with root directory `apps/web`
- [ ] Neon connected; `DATABASE_URL` present in Production and Preview
- [ ] Variables from `.env.example` set, including the four sign-in ones
- [ ] GitHub OAuth app created with callback `https://<site>/auth/github/callback`; your login in `RELAY_ALLOWED_USERS`; signing in works
- [ ] GitHub App configured (environment, or `/setup/github`) and installed on the managed repositories; `/setup/github` lists the installation and `relay link` in each repo prints `ok events`
- [ ] `relay setup --site https://<site>` on a laptop prints a code, `/activate` approves it, `relay doctor` shows the token
- [ ] GitHub org webhook created, recent deliveries return 200
- [ ] Vercel webhook created for the projects that deploy previews
- [ ] Custom domain resolves and `RELAY_PUBLIC_URL` matches it
- [ ] The project is on the team that owns the board; `relay setup --board --site-project <name>` ran on a worker machine and `RELAY_BOARD_FROM` is set; the board page lists the workers
- [ ] A test task (`relay task create`, or an issue labelled `agent:<lane>` by a login in `RELAY_ALLOWED_SENDERS`) shows on the board, and its run produces `task.created`, `run.started`, `step.usage`, `run.finished` and `pr.opened` rows in the feed
