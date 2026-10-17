import { listPendingAccess } from "@relay/core";
import { api, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb } from "@/lib/integrations";
import { oauthOptions } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/** operationId: listAccessRequests. Device-flow requests still waiting for a decision (newest first). */
export const GET = api(
  async (req) => {
    const refused = needsDb(req.nextUrl.pathname);
    if (refused) return refused;
    const rows = await listPendingAccess(await getDb(), oauthOptions());
    const requests = rows.map((r) => ({ user_code: r.user_code, client_name: r.client_name, client_id: r.client_id, scopes: r.scopes, created_at: r.created_at, expires_at: r.expires_at, approve: `/api/v1/access/${encodeURIComponent(r.user_code)}/approve` }));
    return json({ requests, count: requests.length });
  },
  { scope: "tokens:write" },
);
