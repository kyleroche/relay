import { denyAuthorization, issueAuthorizationCode, OAuthError, validateAuthorizeRequest } from "@relay/core";
import { NextResponse, type NextRequest } from "next/server";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { oauthOptions } from "@/lib/oauth";
import { getSession, sessionActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The consent page's form posts here. The session cookie is SameSite=Lax, so a cross-site POST carries no session and
 * is refused; the request is re-validated against the registered client before anything is issued, so the hidden
 * fields cannot smuggle another redirect target. Approve: mint a code, redirect to the client. Deny: redirect with
 * access_denied.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || session.demo) return NextResponse.json({ error: "access_denied", error_description: "Sign in to decide." }, { status: 401 });
  if (dataMode() !== "db") return NextResponse.json({ error: "server_error", error_description: "The authorization server needs a database." }, { status: 503 });
  const form = await req.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v ? v : null;
  };
  const decision = get("decision");
  try {
    const v = await validateAuthorizeRequest(await getDb(), { response_type: "code", client_id: get("client_id"), redirect_uri: get("redirect_uri"), scope: get("scope"), state: get("state"), code_challenge: get("code_challenge"), code_challenge_method: get("code_challenge_method") ?? "S256", resource: get("resource") }, oauthOptions());
    if ("redirectError" in v) return redirectTo(v.redirectError);
    if (decision !== "approve") return redirectTo(denyAuthorization(v.request));
    return redirectTo(await issueAuthorizationCode(await getDb(), v.request, sessionActor(session), oauthOptions()));
  } catch (e) {
    if (e instanceof OAuthError) return NextResponse.json(e.toJSON(), { status: e.status });
    throw e;
  }
}

function redirectTo(url: string): NextResponse {
  const res = NextResponse.redirect(url, 303);
  res.headers.set("cache-control", "no-store");
  return res;
}
