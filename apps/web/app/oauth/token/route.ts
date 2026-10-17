import { exchangeToken } from "@relay/core";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { oauthError, oauthGate, oauthJson, oauthOptions, readParams } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * The token endpoint: `authorization_code` (+ PKCE), `refresh_token` (rotated; a reused one revokes the lineage),
 * `urn:ietf:params:oauth:grant-type:device_code` (answers authorization_pending / slow_down / access_denied /
 * expired_token while the person decides) and `urn:relay:invite` (a one-time code from `relay invite create`).
 * Access tokens live 24 hours and are rows in `tokens` named `oauth:<client name>`; refresh tokens live 90 days.
 */
export async function POST(req: NextRequest) {
  const { rate, refused } = oauthGate(req);
  if (refused) return refused;
  try {
    const params = await readParams(req);
    const out = await exchangeToken(await getDb(), params, oauthOptions());
    return oauthJson(out, 200, rate);
  } catch (e) {
    return oauthError(e, rate, req.nextUrl.pathname);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
}
