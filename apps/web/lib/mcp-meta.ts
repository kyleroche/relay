import { TOOL_SCOPES } from "@relay/mcp";
import { RATE_LIMIT, SCOPES } from "@/lib/api";
import { REPO_URL, SITE_URL } from "@/lib/site";
import { APP_VERSION } from "@/lib/info-doc";

/** The one tool set, from the shared server: name, description and the scope each tool needs (null = public). */
export const MCP_TOOLS = TOOL_SCOPES;

const PUBLIC_READ = new Set(["feed:read", "memory:read"]);

/** MCP registry server.json (modelcontextprotocol.io registry schema). */
export function serverJson() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
    name: "house.kyro.harness/relay",
    description: "relay over MCP: the event feed, projects, shared memory (decisions, preferences, vendor guidance) and the asset library for one person's coding-agent subscriptions.",
    version: APP_VERSION,
    repository: { url: REPO_URL, source: "github" },
    websiteUrl: `${SITE_URL}/`,
    remotes: [{ type: "streamable-http", url: `${SITE_URL}/mcp` }],
  };
}

/** Server card: what a client sees before connecting. */
export function serverCard() {
  return {
    name: "relay",
    version: APP_VERSION,
    description:
      "relay's tools over Streamable HTTP: two always-public tools (what this deployment is, how relay works), feed and project reads, token-gated memory, asset, task (relay_task_*: open, read, approve and merge, request changes, requeue), external-event (relay_event_log), webhook (relay_webhook_*) and, for a tokens:write bot, access and invite tools (relay_access_list, relay_access_approve, relay_invite_create, relay_invite_revoke: approve other agents' device codes and mint invites without the Access page; a bot grants only scopes it holds and never tokens:write). The same tools the stdio server (relay-mcp) exposes to the CLIs.",
    url: `${SITE_URL}/mcp`,
    transport: "streamable-http",
    stateless: true,
    authentication: {
      type: "bearer",
      scheme: "http",
      // Anyone can connect, initialize and list tools; the scopes a token carries decide which calls run.
      anonymous_methods: ["initialize", "tools/list"],
      anonymous_tools: MCP_TOOLS.filter((t) => t.scope === null).map((t) => t.name),
      public_when_public_read: MCP_TOOLS.filter((t) => t.scope !== null && PUBLIC_READ.has(t.scope)).map((t) => t.name),
      required_for: MCP_TOOLS.filter((t) => t.scope !== null && !PUBLIC_READ.has(t.scope)).map((t) => t.name),
      scopes: SCOPES,
      token_issuance: "OAuth 2.1 at this site (register at /oauth/register, authorization code with PKCE S256, or the device flow approved at /activate), an invite code from relay invite create, or relay token create / the /access page (the hash is stored, the token shown once)",
      how_to_get_access: [
        `POST ${SITE_URL}/oauth/device with client_name and scope (registers you); note device_code, user_code, verification_uri`,
        `ask the person to approve user_code at ${SITE_URL}/activate (or a tokens:write bot posts to ${SITE_URL}/api/v1/access/{user_code}/approve or calls the relay_access_approve tool on ${SITE_URL}/mcp; a bot can approve only scopes it holds itself, never tokens:write); poll POST ${SITE_URL}/oauth/token grant_type=urn:ietf:params:oauth:grant-type:device_code until access_token arrives`,
        `retry /mcp with Authorization: Bearer <access_token>; refresh with grant_type=refresh_token before 24 h; relay_whoami tells you what you are`,
        `no browser anywhere: redeem an invite code with grant_type=urn:relay:invite; a browser client uses POST /oauth/register then GET /oauth/authorize (PKCE S256)`,
      ],
      oauth: {
        authorization_server: `${SITE_URL}/.well-known/oauth-authorization-server`,
        resource_metadata: `${SITE_URL}/.well-known/oauth-protected-resource`,
        resource: SITE_URL,
        dynamic_client_registration: `${SITE_URL}/oauth/register`,
        authorization_endpoint: `${SITE_URL}/oauth/authorize`,
        token_endpoint: `${SITE_URL}/oauth/token`,
        device_authorization_endpoint: `${SITE_URL}/oauth/device`,
        revocation_endpoint: `${SITE_URL}/oauth/revoke`,
        code_challenge_methods: ["S256"],
      },
      integrations: `${SITE_URL}/docs/integrations`,
      // A call without the needed scope is an MCP tool error (isError: true) naming the scope; only an unrecognised bearer is HTTP 401.
      denied_as: "tool error",
      documentation: `${SITE_URL}/docs/api#authentication-and-scopes`,
    },
    rate_limit: { policy: RATE_LIMIT.policyName, requests: RATE_LIMIT.limit, window_seconds: RATE_LIMIT.windowSeconds, headers: ["RateLimit-Policy", "RateLimit"] },
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.scope })),
    documentation: `${SITE_URL}/docs/api#mcp-server`,
    registry: `${SITE_URL}/server.json`,
    openapi: `${SITE_URL}/openapi.json`,
    contact: `${SITE_URL}/contact`,
    license: "Apache-2.0",
  };
}
