import { FLOW, RULES, TAGLINE } from "@/lib/content/info";
import { accessSteps } from "@/lib/api";
import { dataMode, publicReadEnabled, REPO_URL, SITE_URL } from "@/lib/data";

export const APP_VERSION = "0.0.1";

/** The /api/v1/info document; also what the MCP tool relay_get_info returns. */
export function infoDocument() {
  return {
    name: "relay",
    version: APP_VERSION,
    tagline: TAGLINE,
    description:
      "An open-source harness that turns one person's coding-agent subscriptions (Claude Code, Codex, Grok) into one system: GitHub issues as the task bus, self-hosted runners on your own machines, shared memory in Postgres, and an event feed of everything agents did and what it cost.",
    license: "Apache-2.0",
    free: true,
    repository: REPO_URL,
    site: SITE_URL,
    data_mode: dataMode(),
    public_read: publicReadEnabled(),
    access: { summary: "Agents request access themselves: register, a person approves a short code once (or an invite code skips it), then retry with the bearer token.", ...accessSteps() },
    link_repository: {
      summary: "A coding agent inside a repository, on a machine with the user's logins, links it itself.",
      join: `npx @kyleroche/relay setup --site ${SITE_URL}   # once per machine; prints a code the person approves at ${SITE_URL}/activate, or use --invite <code>`,
      link: "npx @kyleroche/relay link   # in the repository: registers the project, digests, writes relay.md, owned section, agent:<lane> labels (gh login); --no-digest skips the claude digest",
      work: "npx @kyleroche/relay work --install   # optional: this machine executes the repo's tasks; --yes installs the service",
      docs: `${SITE_URL}/llms.txt`,
    },
    rules: RULES.map((r, i) => ({ n: i + 1, title: r.title, body: r.body })),
    task_flow: FLOW.map((f, i) => ({ n: i + 1, step: f.step, where: f.where, detail: f.detail })),
    links: {
      info: `${SITE_URL}/`,
      about: `${SITE_URL}/about`,
      contact: `${SITE_URL}/contact`,
      privacy: `${SITE_URL}/privacy`,
      docs: `${SITE_URL}/docs`,
      api_docs: `${SITE_URL}/docs/api`,
      openapi: `${SITE_URL}/openapi.json`,
      api_catalog: `${SITE_URL}/.well-known/api-catalog`,
      mcp: `${SITE_URL}/mcp`,
      mcp_server_card: `${SITE_URL}/.well-known/mcp/server-card.json`,
      mcp_registry: `${SITE_URL}/server.json`,
      assets: `${SITE_URL}/assets`,
      assets_api: `${SITE_URL}/api/v1/assets`,
      agent_skills: `${SITE_URL}/.well-known/agent-skills/index.json`,
      ai_catalog: `${SITE_URL}/.well-known/ai-catalog.json`,
      token_issuance: "OAuth 2.1 at this site, an invite code, or relay token create --name <name> --scopes <scopes>",
      oauth_authorization_server: `${SITE_URL}/.well-known/oauth-authorization-server`,
      oauth_protected_resource: `${SITE_URL}/.well-known/oauth-protected-resource`,
      activate: `${SITE_URL}/activate`,
      integrations: `${SITE_URL}/docs/integrations`,
      llms: `${SITE_URL}/llms.txt`,
      llms_full: `${SITE_URL}/llms-full.txt`,
      versioning: `${SITE_URL}/docs/versioning`,
    },
  };
}

export function methodologyText(): string {
  const lines = ["relay: the five rules", ""];
  RULES.forEach((r, i) => lines.push(`${i + 1}. ${r.title} ${r.body}`));
  lines.push("", "A task's life", "");
  FLOW.forEach((f, i) => lines.push(`${i + 1}. ${f.step} (${f.where}). ${f.detail}`));
  lines.push("", "Every step above is a row in the feed.");
  return lines.join("\n");
}
