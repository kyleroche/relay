import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

/**
 * RFC 9727 API catalog: a linkset pointing at the OpenAPI description and the MCP server card. Authentication is a
 * plain bearer token issued by `relay token create`, described in the OpenAPI security scheme; there is no
 * authorization server, so nothing here points at one.
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
    ],
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/linkset+json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
