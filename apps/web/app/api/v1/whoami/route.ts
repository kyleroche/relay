import { api, bearerChallenge, callerGrant, json, problem } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * operationId: whoami. Who the caller is: token name, scopes, expiry and how it authenticated. Any valid credential
 * may ask; anonymous callers get 401 with the challenge that names the authorization server.
 */
export const GET = api(async (req) => {
  const grant = await callerGrant(req);
  const instance = req.nextUrl.pathname;
  if (!grant || grant.name === "anonymous") return problem(401, "Unauthorized", "Send a bearer token or sign in. The WWW-Authenticate header names the authorization server.", instance, {}, { "WWW-Authenticate": bearerChallenge() });
  return json({ actor: grant.actor, name: grant.name, scopes: grant.scopes, expires_at: grant.expiresAt, source: grant.source });
});
