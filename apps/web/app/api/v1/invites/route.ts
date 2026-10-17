import { createInvite, listInvites, OAuthError, parseDuration } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { int, needsDb, readJson, str } from "@/lib/integrations";
import { oauthOptions } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/** operationId: listInvites. Live invites (never the code); `all=1` includes spent, expired and revoked ones. */
export const GET = api(
  async (req) => {
    const refused = needsDb(req.nextUrl.pathname);
    if (refused) return refused;
    const invites = await listInvites(await getDb(), { includeSpent: req.nextUrl.searchParams.get("all") === "1" });
    return json({ invites, count: invites.length });
  },
  { scope: "tokens:write" },
);

/**
 * operationId: createInvite. Body: { name, scopes: string[], expires_in?: "24h" | seconds, uses?: 1 }. The code is
 * returned once; whoever redeems it (`relay setup --site <url> --invite <code>`, or grant urn:relay:invite at
 * /oauth/token) gets a token named oauth:<name> with exactly these scopes, no approval step. A token may invite only
 * to scopes it holds itself and never tokens:write (403); a signed-in person is unrestricted.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const name = str(body.name);
    if (!name) return problem(400, "Bad Request", "name is required.", instance, { parameter: "name" });
    const raw = Array.isArray(body.scopes) ? body.scopes : typeof body.scopes === "string" ? body.scopes.split(",") : [];
    const scopes = raw.map((s) => String(s).trim()).filter(Boolean);
    const expires = body.expires_in === undefined ? undefined : parseDuration(typeof body.expires_in === "number" ? body.expires_in : str(body.expires_in));
    if (body.expires_in !== undefined && !expires) return problem(400, "Bad Request", "expires_in must be a duration like 24h, 7d, or a number of seconds.", instance, { parameter: "expires_in" });
    const uses = int(body.uses);
    const grant = await callerGrant(req);
    try {
      const r = await createInvite(await getDb(), { name, scopes, ...(expires ? { expiresInSeconds: expires } : {}), ...(uses ? { uses } : {}), createdBy: grant?.actor ?? "token:unknown", creatorScopes: grant?.scopes ?? [] }, oauthOptions());
      return json({ invite: r.invite, code: r.code }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof OAuthError && e.status === 403) return problem(403, "Forbidden", e.description, instance, { error: e.code, scopes: grant?.scopes ?? [] });
      if (e instanceof OAuthError) return problem(400, "Bad Request", e.description, instance, { error: e.code });
      throw e;
    }
  },
  { scope: "tokens:write" },
);
