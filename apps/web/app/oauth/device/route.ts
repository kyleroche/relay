import { deviceAuthorization } from "@relay/core";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { oauthError, oauthGate, oauthJson, oauthOptions, readParams } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 8628 device authorization. Body: `client_id` (a registered client) or `client_name` (register a public client on
 * the fly, what `relay setup --site` sends) and `scope`. Returns the device code to poll with, the user code to show
 * (`RLAY-4F7Q`), `verification_uri` (/activate) and `verification_uri_complete`. Writes `access.requested` to the
 * feed so a webhook or Concierge can relay the approval.
 */
export async function POST(req: NextRequest) {
  const { rate, refused } = oauthGate(req);
  if (refused) return refused;
  try {
    const out = await deviceAuthorization(await getDb(), await readParams(req), oauthOptions());
    return oauthJson(out, 200, rate);
  } catch (e) {
    return oauthError(e, rate, req.nextUrl.pathname);
  }
}
