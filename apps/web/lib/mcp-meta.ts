import { REPO_URL, SITE_URL } from "@/lib/data";
import { APP_VERSION } from "@/lib/info-doc";

export const MCP_TOOLS = [
  { name: "relay_get_info", description: "Describe this relay deployment: rules, task flow, links. Public.", scope: null },
  { name: "relay_get_feed", description: "List events newest first with optional project, kind, actor, lane, limit, before, after. Public.", scope: null },
  { name: "relay_get_project", description: "One project by slug with current decisions, models and recent events. Public.", scope: null },
  { name: "relay_get_methodology", description: "The five rules and a task's life, as plain text. Public.", scope: null },
  { name: "relay_recall", description: "Search decisions and vendor guidance. Needs a bearer token with memory:read.", scope: "memory:read" },
  { name: "relay_capture_decision", description: "Record a durable decision for a project. Needs a bearer token with memory:write.", scope: "memory:write" },
] as const;

/** MCP registry server.json (modelcontextprotocol.io registry schema). */
export function serverJson() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
    name: "house.kyro.harness/relay",
    description: "Read model over relay: the event feed, projects, decisions and plan usage for one person's coding-agent subscriptions.",
    version: APP_VERSION,
    repository: { url: REPO_URL, source: "github" },
    websiteUrl: `${SITE_URL}/info`,
    remotes: [{ type: "streamable-http", url: `${SITE_URL}/mcp` }],
  };
}

/** Server card: what a client sees before connecting. */
export function serverCard() {
  return {
    name: "relay",
    version: APP_VERSION,
    description: "Read model over relay's event feed, projects and usage; token-gated memory tools.",
    url: `${SITE_URL}/mcp`,
    transport: "streamable-http",
    stateless: true,
    authentication: {
      type: "bearer",
      required_for: MCP_TOOLS.filter((t) => t.scope).map((t) => t.name),
      scopes: ["memory:read", "memory:write"],
      resource_metadata: `${SITE_URL}/.well-known/oauth-protected-resource`,
    },
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.scope })),
    documentation: `${SITE_URL}/docs/api#mcp-server`,
    registry: `${SITE_URL}/server.json`,
    openapi: `${SITE_URL}/openapi.json`,
    license: "Apache-2.0",
  };
}
