import { decideDeviceRequest, OAuthError } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb, readJson, str } from "@/lib/integrations";
import { oauthOptions } from "@/lib/oauth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

/**
 * operationId: approveAccessRequest. Approve (default) or deny a pending device request by its user code, so a reply
 * over iMessage or Slack can finish what `relay setup --site` started. Body: { "decision": "approve" | "deny" }.
 * Needs tokens:write, or the signed-in session. The decision is attributed to the caller in the access.* event. A
 * token may approve only scopes it holds itself and never tokens:write (403); a signed-in person is unrestricted.
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const { code } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = (await readJson(req)) ?? {};
    const decision = str(body.decision) ?? "approve";
    if (decision !== "approve" && decision !== "deny") return problem(400, "Bad Request", "decision must be approve or deny.", instance, { parameter: "decision" });
    const grant = await callerGrant(req);
    try {
      const row = await decideDeviceRequest(await getDb(), decodeURIComponent(code), decision, grant?.actor ?? "token:unknown", oauthOptions(), grant?.scopes ?? []);
      return json({ user_code: row.user_code, status: row.status, client_name: row.client_name, scopes: row.scopes, decided_by: row.actor });
    } catch (e) {
      if (e instanceof OAuthError && e.status === 403) return problem(403, "Forbidden", e.description, instance, { error: e.code, scopes: grant?.scopes ?? [] });
      if (e instanceof OAuthError) return problem(e.code === "expired_token" ? 410 : 404, e.code === "expired_token" ? "Gone" : "Not Found", e.description, instance, { error: e.code });
      throw e;
    }
  },
  { scope: "tokens:write" },
);
