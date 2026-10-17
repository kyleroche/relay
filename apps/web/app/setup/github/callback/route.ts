import { NextResponse, type NextRequest } from "next/server";
import { dataMode } from "@/lib/data";
import { convertManifest, storeGitHubApp, verifyManifestState } from "@/lib/github-app";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /setup/github/callback?code=&state=: GitHub sends the browser here after the manifest is accepted. The state
 * must have been minted for this signed-in login within the hour; the one-time code is exchanged for the app (id,
 * private key, webhook secret) and stored sealed. Then on to /setup/github, which now shows the install link.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const back = (q: Record<string, string>) => {
    const res = NextResponse.redirect(new URL(`/setup/github?${new URLSearchParams(q).toString()}`, req.nextUrl.origin), 303);
    res.headers.set("cache-control", "no-store");
    return res;
  };
  const session = await getSession();
  if (!session || session.demo) return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`, req.nextUrl.origin), 303);
  if (dataMode() !== "db") return back({ error: "This deployment runs on demo data; storing an app needs a database." });
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code) return back({ error: "GitHub sent no code. Start again." });
  if (!verifyManifestState(state, session.login, process.env.RELAY_SESSION_SECRET)) return back({ error: "That setup attempt expired or did not start here. Start again." });
  try {
    const app = await convertManifest(code);
    await storeGitHubApp(app);
    return back({ created: app.slug });
  } catch (e) {
    return back({ error: e instanceof Error ? e.message : "GitHub did not return an app." });
  }
}
