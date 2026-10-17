/**
 * The trust pages: /about, /contact, /privacy. Each is one Markdown document, rendered to HTML by lib/docs.ts
 * `renderMarkdown` for the page and served as-is for the text/markdown mirror, so the two cannot drift. Links are
 * absolute because the docs renderer maps repo-relative paths to GitHub.
 */
import { AUTHOR, contactEmail, ISSUES_URL, LICENSE_URL, REPO_URL, SECURITY_DOC_URL, SITE_URL } from "@/lib/site";

export type TrustSlug = "about" | "contact" | "privacy";

export interface TrustPage {
  slug: TrustSlug;
  title: string;
  description: string;
  markdown: () => string;
}

function aboutMarkdown(): string {
  return `# About relay

> Your coding-agent subscriptions, working as one system.

## What relay is

relay is an open-source harness for people who pay for more than one coding agent. It makes Claude Code, Codex and Grok Build work as one system: GitHub issues are the task bus, workers on machines you already own (\`relay work\`) claim tasks from relay and run each vendor's own CLI under your own login, a Postgres database holds the shared memory and an append-only event feed, and this site is the read model over it. Credentials never leave the machine they were created on; no token is copied, proxied or stored in CI.

## Who makes it

relay is written and maintained by [${AUTHOR.name}](${AUTHOR.url}). It began as a personal harness for one person's subscriptions and is published so anyone can run their own copy. There is no company behind it, no paid tier and nothing for sale: you bring the subscriptions you already have and the machines you already own.

## Open source

The source is at [github.com/kyleroche/relay](${REPO_URL}) under the [Apache-2.0 license](${LICENSE_URL}). Bug reports, questions and proposals go through [GitHub issues](${ISSUES_URL}). \`AGENTS.md\` in the repository is written for people and coding agents alike and is the place to start when contributing; the design is described in \`docs/ARCHITECTURE.md\`, served here under [Docs](${SITE_URL}/docs).

## This site

${SITE_URL.replace(/^https?:\/\//, "")} is one deployment of relay: the operator's own feed, projects, usage meters and asset library sit behind GitHub sign-in, while the overview, the docs, the OpenAPI description, the MCP server's tool list and the install skill are open to everyone, people and agents alike. Running your own copy is described in the hosting guide in the repository.

## Elsewhere on this site

- [Overview](${SITE_URL}/): the five rules, how a task flows, quick install
- [Docs](${SITE_URL}/docs): architecture, the API and MCP guide, versioning, agent readiness
- [Contact](${SITE_URL}/contact) and [Privacy](${SITE_URL}/privacy)
`;
}

function contactMarkdown(): string {
  const email = contactEmail();
  return `# Contact

## Bugs, questions and ideas

The project's GitHub issue tracker is the front door: [${ISSUES_URL.replace(/^https?:\/\//, "")}](${ISSUES_URL}). Open an issue for a bug, a question about running relay, or a proposal; a public thread means the answer helps the next person who searches for it. Pull requests are welcome; read \`AGENTS.md\` in the repository first, it is written for people and coding agents alike.

## Email

${
  email
    ? `The operator of this deployment can be reached at [${email}](mailto:${email}). Use it for matters about this site specifically, such as a sign-in allowlist request or a data question (see [Privacy](${SITE_URL}/privacy)); questions about relay itself belong in GitHub issues where everyone can see the answer.`
    : `This deployment publishes no email address. Use GitHub issues for anything about relay, and the repository's security advisory form for vulnerabilities (below). The operator can publish an address by setting \`RELAY_CONTACT_EMAIL\`.`
}

## Security reports

Do not open a public issue for a vulnerability. The reporting procedure is in [docs/SECURITY.md](${SECURITY_DOC_URL}): open a private security advisory on the repository, and if a runner was involved include the workflow run id (the Actions log never contains credentials, so it is safe to attach). That document also describes the threat model, what runners may and may not do, and how browser sign-in works.

## Not a sales channel

relay is free and open source under Apache-2.0. There is no sales team, no demo to book and no account to request. Install it from the repository: [github.com/kyleroche/relay](${REPO_URL}). The [overview](${SITE_URL}/) has the quick install and the list of model accounts to link.

## For agents

The read API and the MCP server are described in the [API and MCP guide](${SITE_URL}/docs/api), [\`/openapi.json\`](${SITE_URL}/openapi.json) and the [MCP server card](${SITE_URL}/.well-known/mcp/server-card.json). Tokens come from this site's own OAuth 2.1 authorization server ([metadata](${SITE_URL}/.well-known/oauth-authorization-server)): an MCP client registers itself and asks the operator for consent, a CLI or bot shows a short code the operator approves at [\`/activate\`](${SITE_URL}/activate), or the operator hands out a one-time invite code. Nobody copies a token, and every grant is one approval by a person who signed in here. The [connect guide](${SITE_URL}/docs/integrations) has the steps.
`;
}

function privacyMarkdown(): string {
  return `# Privacy

This page describes what ${SITE_URL.replace(/^https?:\/\//, "")} stores and why. It is short because the site stores very little.

## What this site stores about you

Nothing, until you sign in. Sign-in is with GitHub and only for the logins the operator has allowlisted. A successful sign-in sets one cookie, \`relay_session\`: a signed token holding your GitHub login, display name and avatar URL, valid for 30 days, marked \`HttpOnly\`, \`Secure\` and \`SameSite=Lax\`. There is no server-side session store and no account record. The GitHub access token is used once, to read your public profile, and then dropped; relay never stores it.

A second cookie, \`relay-tz\`, holds your browser's time zone name (for example \`Europe/Lisbon\`) so the feed can render times in your zone on the server. It carries no identity. Your light or dark theme choice stays in your browser's local storage and is never sent to the server.

## No analytics, no trackers

This site runs no analytics scripts, no advertising, no third-party trackers and no fingerprinting. Fonts and scripts are served from the site itself. Requests pass through the hosting provider's standard request logs (IP address, path, user agent), which the operator can see and which the provider retains on its own schedule.

## Whose data the feed is

The feed, projects, usage meters and assets belong to the operator who runs this deployment: they describe the operator's repositories and coding-agent runs. Events arriving from GitHub webhooks name the GitHub logins that acted on those repositories, as GitHub reports them. Anonymous visitors see none of it; the public surface is the overview, the docs, the API description and the MCP server's tool list.

## Deleting your data

Sign out to clear the session cookie; it also expires on its own after 30 days. The operator can sign everyone out at once by rotating \`RELAY_SESSION_SECRET\`. To have your GitHub login removed from a feed event or an asset record, ask the operator through the [contact page](${SITE_URL}/contact); the events table is append-only, so removal is a redaction of the fields that name you, recorded as its own event.

## Running your own copy

If you run relay yourself, everything above describes your deployment: the data lives in your Postgres database and your Blob store, the cookie is signed with your secret, and no telemetry of any kind is sent to the relay project or to its author. The source is at [github.com/kyleroche/relay](${REPO_URL}); the security model is in [docs/SECURITY.md](${SECURITY_DOC_URL}).
`;
}

export const TRUST_PAGES: TrustPage[] = [
  { slug: "about", title: "About relay", description: "What relay is, who makes it, and the Apache-2.0 open-source project behind this site.", markdown: aboutMarkdown },
  { slug: "contact", title: "Contact", description: "Where to report bugs, ask questions, reach the operator of this deployment, and report a security issue.", markdown: contactMarkdown },
  { slug: "privacy", title: "Privacy", description: "What this site stores (a session cookie after GitHub sign-in, nothing else), no analytics or trackers, and how to delete your data.", markdown: privacyMarkdown },
];

export function trustPage(slug: string): TrustPage | undefined {
  return TRUST_PAGES.find((p) => p.slug === slug);
}

export function trustMarkdown(slug: string): string | null {
  return trustPage(slug)?.markdown() ?? null;
}
