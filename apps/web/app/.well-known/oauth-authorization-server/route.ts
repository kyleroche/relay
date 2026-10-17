import { authorizationServerMetadata } from "@relay/core";
import { NextResponse } from "next/server";
import { ISSUER } from "@/lib/oauth";

/** RFC 8414: where to register, authorize, get and revoke tokens, which scopes exist, PKCE S256 only. */
export function GET() {
  return NextResponse.json(authorizationServerMetadata(ISSUER), { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "*", "access-control-max-age": "86400" } });
}
