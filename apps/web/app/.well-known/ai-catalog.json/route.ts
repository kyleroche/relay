import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth";
import { TRUST_PAGES } from "@/lib/content/trust";
import { publicReadEnabled } from "@/lib/data";
import { DOCS } from "@/lib/docs";
import { APP_VERSION } from "@/lib/info-doc";
import { AUTHOR, ISSUES_URL, REPO_URL, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

/** Site catalog for agents: what is here and how to use it, in one file. */
export function GET() {
  return NextResponse.json(
    {
      version: "1.0",
      name: "relay",
      description:
        "Open-source harness that turns one person's coding-agent subscriptions (Claude Code, Codex, Grok) into one system. Free, Apache-2.0.",
      site_type: "app",
      url: SITE_URL,
      software_version: APP_VERSION,
      license: "Apache-2.0",
      author: { name: AUTHOR.name, url: AUTHOR.url },
      pricing: { model: "free", notes: "No paid tier. Bring your own vendor subscriptions." },
      repository: REPO_URL,
      support: ISSUES_URL,
      pages: [
        { url: `${SITE_URL}/`, title: "What relay is", description: "The five rules, how a task flows, quick install, linking accounts. The feed for a signed-in viewer.", markdown: true },
        ...TRUST_PAGES.map((p) => ({ url: `${SITE_URL}/${p.slug}`, title: p.title, description: p.description, markdown: true })),
        ...DOCS.map((d) => ({ url: `${SITE_URL}/docs/${d.slug}`, title: d.title, description: d.description, markdown: true })),
        { url: `${SITE_URL}/projects`, title: "Projects", description: "Linked repositories with decisions and digest coverage.", access: "session" },
        { url: `${SITE_URL}/usage`, title: "Usage", description: "Calls, tokens, cost equivalent and plan meters per subscription.", access: "session" },
        { url: `${SITE_URL}/workers`, title: "Workers", description: "Health of self-hosted runners.", access: "session" },
      ],
      apis: [
        { type: "openapi", url: `${SITE_URL}/openapi.json`, base_url: `${SITE_URL}/api/v1`, docs: `${SITE_URL}/docs/api` },
        {
          type: "mcp",
          url: `${SITE_URL}/mcp`,
          transport: "streamable-http",
          server_card: `${SITE_URL}/.well-known/mcp/server-card.json`,
          registry: `${SITE_URL}/server.json`,
          anonymous: ["initialize", "tools/list", "relay_get_info", "relay_get_methodology"],
        },
      ],
      skills: `${SITE_URL}/.well-known/agent-skills/index.json`,
      llms_txt: `${SITE_URL}/llms.txt`,
      llms_full_txt: `${SITE_URL}/llms-full.txt`,
      sitemap: `${SITE_URL}/sitemap.xml`,
      auth: {
        scheme: "http",
        type: "bearer",
        issuance: "OAuth 2.1 at this site (authorization code + PKCE, device flow, or an invite code), or relay token create on the operator's machine; the hash is stored, the token shown once",
        oauth: {
          authorization_server: `${SITE_URL}/.well-known/oauth-authorization-server`,
          resource_metadata: `${SITE_URL}/.well-known/oauth-protected-resource`,
          dynamic_client_registration: true,
          pkce: ["S256"],
          grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:relay:invite"],
          device_verification_uri: `${SITE_URL}/activate`,
          access_token_lifetime_seconds: 86_400,
          refresh_token_lifetime_seconds: 90 * 86_400,
        },
        scopes: SCOPES,
        docs: `${SITE_URL}/docs/api#authentication-and-scopes`,
        connect: `${SITE_URL}/docs/integrations`,
        public_read: publicReadEnabled(),
      },
      versioning: `${SITE_URL}/docs/versioning`,
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
