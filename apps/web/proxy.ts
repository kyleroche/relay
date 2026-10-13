import { NextResponse, type NextRequest } from "next/server";

/**
 * Content negotiation for the pages that have Markdown mirrors (/info, /docs, /docs/*).
 * text/markdown preferred over text/html -> rewrite to /api/markdown. Nothing acceptable -> 406.
 * Every response carries Vary: Accept.
 *
 * TODO(auth): session checks for the app pages also belong here once sign-in lands.
 */

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

export default function proxy(req: NextRequest) {
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

export const config = {
  matcher: ["/info", "/docs", "/docs/:path*"],
};
