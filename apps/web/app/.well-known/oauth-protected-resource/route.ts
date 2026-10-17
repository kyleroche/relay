import { protectedResourceMetadata } from "@relay/core";
import { NextResponse } from "next/server";
import { ISSUER } from "@/lib/oauth";

/** RFC 9728: this site's API and MCP server name their authorization server (this site). Linked from every 401. */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(ISSUER), { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "*", "access-control-max-age": "86400" } });
}
