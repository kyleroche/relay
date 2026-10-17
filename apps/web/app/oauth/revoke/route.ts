import { revokeToken } from "@relay/core";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { oauthError, oauthGate, oauthJson, oauthOptions, readParams } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/** RFC 7009: `token=<access or refresh token>`. Always 200; the token is gone whether or not it existed. */
export async function POST(req: NextRequest) {
  const { rate, refused } = oauthGate(req);
  if (refused) return refused;
  try {
    const params = await readParams(req);
    if (!params.token) return oauthJson({ error: "invalid_request", error_description: "token is required." }, 400, rate);
    const r = await revokeToken(await getDb(), params.token, oauthOptions());
    return oauthJson({ revoked: r.revoked !== "none", kind: r.revoked }, 200, rate);
  } catch (e) {
    return oauthError(e, rate, req.nextUrl.pathname);
  }
}
