import { registerClient } from "@relay/core";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { oauthError, oauthGate, oauthJson, oauthOptions, readParams } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 7591 dynamic client registration. Open to anyone (an MCP client registers itself before it can ask for consent):
 * registering grants nothing, a person still approves every token. Public clients by default; `client_secret_post`
 * gets a secret, shown once.
 */
export async function POST(req: NextRequest) {
  const { rate, refused } = oauthGate(req);
  if (refused) return refused;
  try {
    const body = req.headers.get("content-type")?.includes("application/json") ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : await readParams(req);
    const out = await registerClient(await getDb(), body, oauthOptions());
    return oauthJson(out, 201, rate);
  } catch (e) {
    return oauthError(e, rate, req.nextUrl.pathname);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
}
