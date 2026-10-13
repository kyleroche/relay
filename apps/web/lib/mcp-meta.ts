import { TOOL_SCOPES } from "@relay/mcp";
import { SCOPES } from "@/lib/auth";
import { REPO_URL, SITE_URL } from "@/lib/data";
import { APP_VERSION } from "@/lib/info-doc";

/** The one tool set, from the shared server: name, description and the scope each tool needs (null = public). */
export const MCP_TOOLS = TOOL_SCOPES;

/** MCP registry server.json (modelcontextprotocol.io registry schema). */
export function serverJson() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
    name: "house.kyro.harness/relay",
    description: "relay over MCP: the event feed, projects, shared memory (decisions, preferences, vendor guidance) and the asset library for one person's coding-agent subscriptions.",
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
    description: "Public read tools over relay's feed and projects; token-gated memory and asset tools. The same tools the stdio server (relay-mcp) exposes to the CLIs.",
    url: `${SITE_URL}/mcp`,
    transport: "streamable-http",
    stateless: true,
    authentication: {
      type: "bearer",
      required_for: MCP_TOOLS.filter((t) => t.scope && t.scope !== "feed:read" && t.scope !== "memory:read").map((t) => t.name),
      public_when_public_read: MCP_TOOLS.filter((t) => t.scope === "feed:read" || t.scope === "memory:read").map((t) => t.name),
      scopes: SCOPES,
      token_issuance: "relay token create --name <name> --scopes <scopes>",
      resource_metadata: `${SITE_URL}/.well-known/oauth-protected-resource`,
    },
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.scope })),
    documentation: `${SITE_URL}/docs/api#mcp-server`,
    registry: `${SITE_URL}/server.json`,
    openapi: `${SITE_URL}/openapi.json`,
    license: "Apache-2.0",
  };
}
