import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

/**
 * RFC 9727 API catalog: a linkset pointing at the OpenAPI description, the MCP server card, and the authorization
 * server's metadata (RFC 8414) and the protected-resource document (RFC 9728) that names it, so an agent that finds
 * this file can get a token without a person copying one.
 */
export function GET() {
  const body = {
    linkset: [
      {
        anchor: `${SITE_URL}/api/v1`,
        "service-desc": [{ href: `${SITE_URL}/openapi.json`, type: "application/vnd.oai.openapi+json;version=3.1" }],
        "service-doc": [{ href: `${SITE_URL}/docs/api`, type: "text/html" }],
        status: [{ href: `${SITE_URL}/api/v1/info`, type: "application/json" }],
      },
      {
        anchor: `${SITE_URL}/mcp`,
        "service-desc": [{ href: `${SITE_URL}/.well-known/mcp/server-card.json`, type: "application/json" }],
        "service-doc": [{ href: `${SITE_URL}/docs/api#mcp-server`, type: "text/html" }],
      },
      {
        anchor: `${SITE_URL}/`,
        "service-meta": [
          { href: `${SITE_URL}/.well-known/oauth-authorization-server`, type: "application/json", title: "OAuth 2.1 authorization server metadata (RFC 8414)" },
          { href: `${SITE_URL}/.well-known/oauth-protected-resource`, type: "application/json", title: "Protected resource metadata (RFC 9728)" },
        ],
        "service-doc": [{ href: `${SITE_URL}/docs/integrations`, type: "text/html" }],
      },
    ],
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/linkset+json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
