# Hosting the web app

The web app (`apps/web`) is a Next.js app that shows the feed, projects and usage meters, serves the HTTP memory
server, and ingests webhooks from GitHub and Vercel. It holds no vendor credentials: it only ever receives events
and usage numbers that runners and GitHub send it. It deploys to Vercel with a Neon Postgres database.

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

## 3. Environment variables

`.env.example` at the repo root lists every name the app reads. Set each one in Vercel → Project → Settings →
Environment Variables (Production and Preview), or with `vercel env add NAME`.

| Name | From | Used by |
|---|---|---|
| `DATABASE_URL` | Neon integration (automatic) | everything that touches Postgres |
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
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | the GitHub App (step 4b), or leave unset and use the manifest flow on `/setup/github` | opening tasks, asset comments, reopening rejected issues, the `relay.md` probe on install, as the app; installation tokens per repository, in memory only. The environment wins over a stored app |
| `GITHUB_APP_SLUG` | the app's URL slug (optional with the environment pair) | the install link on `/setup/github` |
| `GITHUB_APP_TOKEN` or `GITHUB_TOKEN` | a fine-grained token with issues:write on the managed repos | the fallback when no app is configured: asset comments, reopening rejected issues, opening tasks |
| `RELAY_ALLOWED_SENDERS` | comma-separated logins | which commenters' usage blocks count towards the ledger (else the repo variable of the same name, else everyone), and who may open a task for a worker by labelling an issue (else the repo variable; with neither, nobody) |
| `GITHUB_OAUTH_CLIENT_ID` | the GitHub OAuth app (step 4) | browser sign-in |
| `GITHUB_OAUTH_CLIENT_SECRET` | the same OAuth app, generated once | browser sign-in; the code exchange |
| `RELAY_SESSION_SECRET` | `openssl rand -hex 32` (at least 32 characters; shorter is refused) | signs the `relay_session` cookie (HS256) and seals the GitHub App key the manifest flow stores; rotating it signs everyone out and makes a stored app unreadable |
| `RELAY_ALLOWED_USERS` | comma-separated GitHub logins, e.g. `kyle,octocat` | who may sign in (case-insensitive; empty means nobody) |
| `RELAY_REVIEWER` | optional actor, mock mode only | who the demo's approve/reject clicks are attributed to (default `human:demo`); with a database the signed-in user is the reviewer |
| `RELAY_PLAN_METERS` | optional JSON | plan meters for the header until a vendor route exists: `[{"id","label","subscription","percentUsed","resetsAt"}]` |

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

## 4b. GitHub App (tasks, comments, the task bus)

The web app acts on GitHub as an App installed once per organization, so no person's token is stored anywhere. Two
ways to set it up; the environment always wins over a stored app, which is also how you rotate.

**One click (fresh deployment).** Sign in, open `https://<site>/setup/github`, optionally name the organization that
should own the app, and press Create. The page posts a GitHub App manifest (name `relay-<host>`, permissions Actions
read, Contents read, Deployments read, Issues write, Metadata read, Pull requests write; events issues, issue_comment,
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

## 5. GitHub webhook (organization level)

With the GitHub App installed you need no separate webhook: the app delivers the same events to
`https://<site>/api/webhooks/github`, plus `installation` and `installation_repositories`, which become
`project.github_connected` rows (and register a project when the repository holds a `relay.md`). Keep an organization
webhook only for repositories the app is not installed on. Organization → Settings → Webhooks → Add webhook:

- Payload URL: `https://<RELAY_PUBLIC_URL>/api/webhooks/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: *Let me select individual events* → Issues, Issue comments, Pull requests, Pull request reviews,
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

## 8. Publishing the CLI to npm

The `relay` command ships as `@kyleroche/relay` (`packages/cli`, built with `tsup` into `dist/`: the CLI, the stdio
MCP server, the hook scripts and the SQL migrations, plus the workflow templates). `.github/workflows/release.yml`
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

## 9. Checklist

- [ ] Project imported with root directory `apps/web`
- [ ] Neon connected; `DATABASE_URL` present in Production and Preview
- [ ] Variables from `.env.example` set, including the four sign-in ones
- [ ] GitHub OAuth app created with callback `https://<site>/auth/github/callback`; your login in `RELAY_ALLOWED_USERS`; signing in works
- [ ] GitHub App configured (environment, or `/setup/github`) and installed on the managed repositories; `/setup/github` lists the installation
- [ ] `relay setup --site https://<site>` on a laptop prints a code, `/activate` approves it, `relay doctor` shows the token
- [ ] GitHub org webhook created, recent deliveries return 200
- [ ] Vercel webhook created for the projects that deploy previews
- [ ] Custom domain resolves and `RELAY_PUBLIC_URL` matches it
- [ ] A labelled test issue produces `run.started`, `step.usage`, `pr.opened` rows in the feed
