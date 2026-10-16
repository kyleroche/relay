import { isTokenScope, repo, TOKEN_SCOPES } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { needsDb, readJson, str } from "@/lib/integrations";

export const dynamic = "force-dynamic";

/** operationId: listTokens. Every token's metadata, never the secret. `all=1` includes revoked ones. */
export const GET = api(
  async (req) => {
    const refused = needsDb(req.nextUrl.pathname);
    if (refused) return refused;
    const all = req.nextUrl.searchParams.get("all") === "1";
    const tokens = await repo.listTokens(await getDb(), { includeRevoked: all });
    return json({ tokens, count: tokens.length });
  },
  { scope: "tokens:write" },
);

/**
 * operationId: createToken. Body: { name, scopes: string[] }. Mints a bearer token for this site and returns the
 * plaintext once, with the row. A signed-in viewer (the /tokens page) or a token carrying tokens:write may call it.
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
    if (name.length > 80) return problem(400, "Bad Request", "name must be at most 80 characters.", instance, { parameter: "name" });
    const raw = Array.isArray(body.scopes) ? body.scopes : typeof body.scopes === "string" ? body.scopes.split(",") : [];
    const scopes = raw.map((s) => String(s).trim()).filter(Boolean);
    const bad = scopes.filter((s) => !isTokenScope(s));
    if (!scopes.length) return problem(400, "Bad Request", `scopes is required; one or more of ${TOKEN_SCOPES.join(", ")}.`, instance, { parameter: "scopes" });
    if (bad.length) return problem(400, "Bad Request", `Unknown scope(s): ${bad.join(", ")}. Valid: ${TOKEN_SCOPES.join(", ")}.`, instance, { parameter: "scopes" });
    const grant = await callerGrant(req);
    const { token, row } = await repo.createToken(await getDb(), { name, scopes, createdBy: grant?.actor ?? "token:unknown" });
    return json({ ...row, token }, { status: 201, headers: { "cache-control": "no-store" } });
  },
  { scope: "tokens:write" },
);
