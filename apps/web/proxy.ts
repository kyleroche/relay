import { NextResponse, type NextRequest } from "next/server";
import { classifyRoute, isApiPath } from "@/lib/access";
import { dataMode, publicReadEnabled } from "@/lib/mode";
import { hasMarkdownMirror, homeDecision, MARKDOWN_PATH_HEADER, negotiateFormat, type Format } from "@/lib/negotiate";
import { SESSION_COOKIE, verifySession } from "@/lib/session-token";

/**
 * Three jobs, in this order:
 *
 * 1. The homepage. `/` is the public landing for anonymous visitors and the feed for a signed-in viewer (and for
 *    everyone in mock mode, which has no sign-in). The landing negotiates Markdown like the other public pages; the
 *    feed is an app page and always HTML. `homeDecision` (lib/negotiate.ts) makes the call.
 *
 * 2. Content negotiation for the pages with Markdown mirrors (/info, /about, /contact, /privacy, /docs, /docs/*):
 *    text/markdown preferred over text/html -> rewrite to /api/markdown. Nothing acceptable -> 406. Every response
 *    carries Vary: Accept. Unknown paths get the same treatment so an agent that asked for Markdown gets a Markdown
 *    404 body from /api/markdown instead of the HTML not-found page.
 *
 * 3. Sign-in gate. `classifyRoute` (lib/access.ts) says which paths are public; the session pages need a valid
 *    `relay_session` cookie (lib/session-token.ts). Pages without one redirect to /sign-in?next=<path>; API paths
 *    answer 401 as problem+json. Unknown paths fall through to Next's 404.
 */

function markdownRewrite(req: NextRequest, vary: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/api/markdown";
  url.search = "";
  url.searchParams.set("path", req.nextUrl.pathname);
  const headers = new Headers(req.headers);
  headers.set(MARKDOWN_PATH_HEADER, req.nextUrl.pathname);
  const res = NextResponse.rewrite(url, { request: { headers } });
  res.headers.set("vary", vary);
  return res;
}

function notAcceptable(pathname: string, vary: string): NextResponse {
  return new NextResponse(
    JSON.stringify({ type: "about:blank", title: "Not Acceptable", status: 406, detail: "This resource is available as text/html or text/markdown.", instance: pathname }),
    { status: 406, headers: { "content-type": "application/problem+json; charset=utf-8", vary } },
  );
}

/** Serve a negotiated page in the chosen format; HTML goes on to the page itself with `Vary` set. */
function serve(req: NextRequest, format: Format, vary = "Accept"): NextResponse {
  if (req.method !== "GET" && req.method !== "HEAD") return NextResponse.next();
  if (format === "markdown") return markdownRewrite(req, vary);
  if (format === "none") return notAcceptable(req.nextUrl.pathname, vary);
  const res = NextResponse.next();
  res.headers.set("vary", vary);
  return res;
}

/** Let the request through, telling `requireSession()` which path it is for. */
function pass(req: NextRequest, vary?: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set("x-relay-path", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  const res = NextResponse.next({ request: { headers } });
  if (vary) res.headers.set("vary", vary);
  return res;
}

function readSession(req: NextRequest) {
  return verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.RELAY_SESSION_SECRET);
}

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  const mock = dataMode() === "mock";
  const accept = req.headers.get("accept");

  if (pathname === "/") {
    const signedIn = mock ? true : (await readSession(req)) !== null;
    const decision = homeDecision({ signedIn, mock, accept });
    // the response depends on the cookie as well as on Accept
    if (decision.view === "feed") return pass(req, "Accept, Cookie");
    return serve(req, decision.format, "Accept, Cookie");
  }
  if (hasMarkdownMirror(pathname)) return serve(req, negotiateFormat(accept));

  const hasBearer = /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
  const access = classifyRoute(pathname, { hasBearer, publicRead: publicReadEnabled(), method: req.method });
  if (access === "unknown") {
    // Next answers 404; an agent that prefers Markdown gets the Markdown error body instead of the HTML page.
    if ((req.method === "GET" || req.method === "HEAD") && negotiateFormat(accept) === "markdown") return markdownRewrite(req, "Accept");
    const res = NextResponse.next();
    res.headers.set("vary", "Accept");
    return res;
  }
  if (access === "public") return NextResponse.next();
  if (mock) return pass(req);

  const session = await readSession(req);
  if (session) return pass(req);

  if (isApiPath(pathname)) {
    return new NextResponse(
      JSON.stringify({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: pathname.startsWith("/api/v1/") ? "This operation needs a bearer token or a signed-in session." : "This endpoint needs a signed-in session.",
        instance: pathname,
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/problem+json; charset=utf-8",
          "cache-control": "no-store",
          "WWW-Authenticate": `Bearer realm="relay"`,
          // the readiness contract wants rate-limit headers on every API response, including refusals
          "RateLimit-Policy": '"default";q=60;w=60',
          RateLimit: '"default";r=60;t=60',
        },
      },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  const res = NextResponse.redirect(url, 307);
  res.headers.set("cache-control", "no-store");
  return res;
}

export const config = {
  // Everything except Next's static output; lib/access.ts decides what is public.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
