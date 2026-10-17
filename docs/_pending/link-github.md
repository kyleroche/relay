# Pending: `relay link` GitHub App check (files owned by another build)

What the build that added `GET /api/v1/projects/{slug}/github`, `RelayClient.githubStatus` and the `events` stage of
`relay link` needs added to files it must not touch. Apply, then delete this file.

## apps/web/lib/openapi-ext.ts

Add a path entry next to `"/projects/{slug}"` (same helpers: `slugParam`, `response`, `problemResponse`, `commonErrors`):

```ts
"/projects/{slug}/github": {
  get: {
    operationId: "getProjectGitHub",
    tags: ["projects"],
    summary: "Will GitHub events for this project's repository reach this site?",
    description:
      "The check `relay link` prints as its `events` stage and `relay doctor` repeats per project. `app.installed` is the GitHub App's installation discovery for the repo (`GET /repos/{owner}/{repo}/installation`, cached up to an hour); false with `configured: false` when the site has no App. `install_url` is the App's install page, or this site's `/setup/github` when no App is configured. `webhook` counts the GitHub deliveries already recorded for the repo (events with a `github:` dedupe key: an organization or repository webhook, or the App's own) and is omitted in mock mode. Readable with `feed:read` or `projects:write` (the scope `relay link` holds), or a session.",
    security: [{ bearer: ["feed:read"] }, { bearer: ["projects:write"] }],
    parameters: [slugParam],
    responses: { "200": response("The status.", "#/components/schemas/ProjectGitHubStatus"), "404": problemResponse("No such project."), ...commonErrors },
  },
},
```

Add the schema under `components.schemas`:

```ts
ProjectGitHubStatus: {
  type: "object",
  required: ["repo", "app"],
  properties: {
    repo: { type: ["string", "null"], description: "owner/name, or null when the project has no repository." },
    app: {
      type: "object",
      required: ["configured", "slug", "installed", "installation_id", "install_url"],
      properties: {
        configured: { type: "boolean", description: "This site acts as a GitHub App (environment or /setup/github)." },
        slug: { type: ["string", "null"] },
        installed: { type: "boolean", description: "The App is installed on the repository." },
        installation_id: { type: ["integer", "null"] },
        install_url: { type: "string", format: "uri", description: "Where to install the App; the site's /setup/github when none is configured." },
        error: { type: "string", description: "Why the installation could not be checked; absent when the answer is reliable." },
      },
    },
    webhook: {
      type: "object",
      required: ["org_or_repo_hook_seen", "last_delivery_at"],
      properties: {
        org_or_repo_hook_seen: { type: "boolean", description: "At least one GitHub delivery for the repository has been recorded." },
        last_delivery_at: { type: ["string", "null"], format: "date-time" },
      },
      description: "Omitted when the deployment cannot say (mock mode).",
    },
  },
},
```

Note on `webhook`: there is no table of inbound GitHub deliveries (`webhook_deliveries` holds relay's *outbound*
deliveries), so the object is derived from the feed: `repo.githubDeliveryStats(db, repo)` counts events with
`repo = <owner/name>` and `dedupe_key LIKE 'github:%'` (every ingested GitHub delivery, App or org webhook, carries
one) and reports the newest `ts`. It cannot tell an organization webhook from the App's own deliveries.

## apps/web/lib/content/api.ts

After the `### GET /api/v1/projects/{slug}` entry:

```md
### GET /api/v1/projects/{slug}/github

`operationId: getProjectGitHub`. Will GitHub events for the project's repository reach this site? `app.installed` is the GitHub App's installation discovery for the repo (`configured: false` when the site has no App), `install_url` where to install it (this site's `/setup/github` when none is configured), `webhook` the GitHub deliveries already recorded for the repo. `relay link` prints this as its `events` stage; `relay doctor` lists the linked projects still missing the App. Scope `feed:read` or `projects:write`.

```bash
curl -s ${SITE_URL}/api/v1/projects/relay/github -H "Authorization: Bearer $TOKEN" | jq '{installed: .app.installed, install_url: .app.install_url}'
```
```

## AGENTS.md

- Layout, `packages/cli`: the `link` command group description is fine; add to the `relay link` sentence in
  "Installing relay for a user", step 3, after "It prints every stage and ends with one cost line.":
  "In site mode its last stage, `events`, checks that the site's GitHub App is installed on the repo and prints the
  install link when it is not; give that link to the user (one install covers every repo they pick). `--no-events`
  skips it."
- Commands block: `pnpm relay link       # ... workflows, labels; idempotent` → append ", GitHub App check (site mode)".
- Layout, `packages/core`, `client/`: after "`RelayClient`: the command surface ..." add "including `githubStatus(slug)`
  (`GET /api/v1/projects/{slug}/github` on a site; no App and the site's `/setup/github` as install link locally)".
- Layout, `apps/web`: the `/api/v1` list gains "the GitHub status of a project (`/api/v1/projects/{slug}/github`)".

## docs/INTEGRATIONS.md

In the section that lists what a bot can read under `/api/v1` (projects), one bullet:

"`GET /api/v1/projects/{slug}/github` (`feed:read` or `projects:write`): whether the site's GitHub App is installed on
the project's repo and where to install it; the same answer `relay link` prints as its `events` stage."

## Nothing needed in packages/mcp

No MCP tool was added; `relay_project` could surface `app.installed` later if a bot needs it.
