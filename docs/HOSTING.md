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
| `RELAY_PUBLIC_URL` | the deployed URL, e.g. `https://relay.example.com` | absolute links in the feed, webhook self-checks |
| `RELAY_MEMORY_TOKEN` | you generate it | bearer token for the HTTP memory server (`/api/memory`) |

Secrets are values, never files: nothing in the repo contains one, and `.env.example` stays names-only.

## 4. GitHub webhook (organization level)

One webhook on the organization feeds every repo relay manages. Organization → Settings → Webhooks → Add webhook:

- Payload URL: `https://<RELAY_PUBLIC_URL>/api/webhooks/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: *Let me select individual events* → Issues, Issue comments, Pull requests, Pull request reviews,
  Workflow jobs, Workflow runs, Pushes.

`docs/FEED.md` lists which event becomes which feed row. The handler is idempotent on the `X-GitHub-Delivery`
header (`events.dedupe_key`), so GitHub's redeliveries are safe to use when debugging.

If you cannot create org webhooks, add the same webhook to each linked repo; `relay link` prints the URL and
events to use.

## 5. Vercel webhook

For the projects whose previews you want in the feed (the repos the lanes work on, deployed on Vercel):

- Vercel → Team Settings → Webhooks → Create: URL `https://<RELAY_PUBLIC_URL>/api/webhooks/vercel`, events
  `deployment.created`, `deployment.succeeded`, `deployment.error`, `deployment.canceled`; select the projects.
- Copy the secret Vercel shows into `VERCEL_WEBHOOK_SECRET` and redeploy the web app.

Each `deployment.succeeded` for a `relay/` branch becomes a `preview.ready` event linked to the PR.

## 6. Custom domain

Vercel → Project → Settings → Domains → Add `relay.example.com`, then create the DNS record Vercel shows (a CNAME
to `cname.vercel-dns.com`, or Vercel nameservers for the whole zone). Certificates are issued automatically. After
the domain resolves, set `RELAY_PUBLIC_URL` to it and update the two webhook URLs above.

Keep the app private: enable Vercel Authentication (Deployment Protection) for previews, and put the production
URL behind the app's own login or Vercel's password protection. The feed shows your repos' issue titles and spend.

## 7. Checklist

- [ ] Project imported with root directory `apps/web`
- [ ] Neon connected; `DATABASE_URL` present in Production and Preview
- [ ] Six variables from `.env.example` set
- [ ] GitHub org webhook created, recent deliveries return 200
- [ ] Vercel webhook created for the projects that deploy previews
- [ ] Custom domain resolves and `RELAY_PUBLIC_URL` matches it
- [ ] A labelled test issue produces `run.started`, `step.usage`, `pr.opened` rows in the feed
