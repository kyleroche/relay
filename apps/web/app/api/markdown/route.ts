import { NextResponse, type NextRequest } from "next/server";
import { infoMarkdown } from "@/lib/content/info";
import { trustMarkdown } from "@/lib/content/trust";
import { DOCS, docMarkdown } from "@/lib/docs";
import { MARKDOWN_PATH_HEADER, notFoundMarkdown } from "@/lib/negotiate";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Markdown mirrors. proxy.ts rewrites /, /info, /about, /contact, /privacy, /docs and /docs/<slug> here when the
 * Accept header prefers text/markdown, and unknown paths too so the 404 an agent gets is Markdown. The page comes in
 * the x-relay-markdown-path request header (a rewrite's query does not reach the handler); direct GETs with ?path=
 * work as well.
 */
export function GET(req: NextRequest) {
  const raw = req.headers.get(MARKDOWN_PATH_HEADER) ?? req.nextUrl.searchParams.get("path") ?? "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  let md: string | null = null;
  if (path === "/" || path === "/info") md = infoMarkdown();
  else if (path === "/about" || path === "/contact" || path === "/privacy") md = trustMarkdown(path.slice(1));
  else if (path === "/docs") {
    md = ["# relay docs", "", ...DOCS.map((d) => `- [${d.title}](${SITE_URL}/docs/${d.slug}): ${d.description}`), "", `Full text: ${SITE_URL}/llms-full.txt`, ""].join("\n");
  } else if (path.startsWith("/docs/")) md = docMarkdown(path.slice("/docs/".length));
  if (md == null) {
    return new NextResponse(notFoundMarkdown(path, SITE_URL), {
      status: 404,
      headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept", "cache-control": "no-store" },
    });
  }
  const canonical = path === "/info" ? "/" : path;
  return new NextResponse(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      vary: path === "/" ? "Accept, Cookie" : "Accept",
      "cache-control": path === "/contact" ? "no-store" : "public, max-age=300",
      link: `<${SITE_URL}${canonical}>; rel="canonical"; type="text/html"`,
    },
  });
}
