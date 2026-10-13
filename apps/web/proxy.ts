import { NextResponse, type NextRequest } from "next/server";
import { classifyRoute, isApiPath } from "@/lib/access";
import { dataMode, publicReadEnabled } from "@/lib/mode";
import { SESSION_COOKIE, verifySession } from "@/lib/session-token";

/**
 * Two jobs, in this order:
 *
 * 1. Sign-in gate. `classifyRoute` (lib/access.ts) says which paths are public; everything else needs a valid
 *    `relay_session` cookie (lib/session-token.ts). Pages without one redirect to /sign-in?next=<path>; API paths
 *    answer 401 as problem+json. Mock mode has no sign-in: every request passes with the fake demo session that
 *    `getSession()` returns.
 *
 * 2. Content negotiation for the pages that have Markdown mirrors (/info, /docs, /docs/*): text/markdown preferred
 *    over text/html -> rewrite to /api/markdown. Nothing acceptable -> 406. Every response carries Vary: Accept.
 */

const NEGOTIATED = /^\/(info|docs)(\/.*)?$/;

interface Range {
  type: string;
  q: number;
}

function parseAccept(header: string): Range[] {
  return header
    .split(",")
    .map((part) => {
      const [type = "*/*", ...params] = part.trim().split(";");
      let q = 1;
      for (const p of params) {
        const [k, v] = p.trim().split("=");
        if (k === "q" && v) q = Number.parseFloat(v) || 0;
      }
      return { type: type.trim().toLowerCase(), q };
    })
    .filter((r) => r.type.length > 0);
}

function quality(ranges: Range[], mediaType: string): number {
  const [major] = mediaType.split("/");
  let best = 0;
  let specificity = -1;
  for (const r of ranges) {
    let s = -1;
    if (r.type === mediaType) s = 2;
    else if (r.type === `${major}/*`) s = 1;
    else if (r.type === "*/*") s = 0;
    if (s > specificity) {
      specificity = s;
      best = r.q;
    }
  }
  return best;
}

function negotiate(req: NextRequest): NextResponse {
  if (req.method !== "GET" && req.method !== "HEAD") return NextResponse.next();
  const { pathname } = req.nextUrl;
  const ranges = parseAccept(req.headers.get("accept") ?? "*/*");
  const md = quality(ranges, "text/markdown");
  const html = Math.max(quality(ranges, "text/html"), quality(ranges, "application/xhtml+xml"));

  if (md > 0 && md > html) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/markdown";
    url.search = "";
    url.searchParams.set("path", pathname);
    const res = NextResponse.rewrite(url);
    res.headers.set("vary", "Accept");
    return res;
  }
  if (html === 0 && md === 0) {
    return new NextResponse(
      JSON.stringify({ type: "about:blank", title: "Not Acceptable", status: 406, detail: "This resource is available as text/html or text/markdown.", instance: pathname }),
      { status: 406, headers: { "content-type": "application/problem+json; charset=utf-8", vary: "Accept" } },
    );
  }
  const res = NextResponse.next();
  res.headers.set("vary", "Accept");
  return res;
}

/** Let the request through, telling `requireSession()` which path it is for. */
function pass(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set("x-relay-path", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  if (NEGOTIATED.test(pathname)) return negotiate(req);

  const hasBearer = /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
  const access = classifyRoute(pathname, { hasBearer, publicRead: publicReadEnabled(), method: req.method });
  if (access === "public") return NextResponse.next();
  if (dataMode() === "mock") return pass(req);

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.RELAY_SESSION_SECRET);
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
          "WWW-Authenticate": `Bearer realm="relay", resource_metadata="${req.nextUrl.origin}/.well-known/oauth-protected-resource"`,
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
