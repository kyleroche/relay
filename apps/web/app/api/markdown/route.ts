import { NextResponse, type NextRequest } from "next/server";
import { infoMarkdown } from "@/lib/content/info";
import { DOCS, docMarkdown } from "@/lib/docs";
import { SITE_URL } from "@/lib/data";

/**
 * Markdown mirrors. proxy.ts rewrites /info, /docs and /docs/<slug> here when the
 * Accept header prefers text/markdown. Direct GETs with ?path= work too.
 */
export function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") ?? "/info";
  let md: string | null = null;
  if (path === "/info") md = infoMarkdown();
  else if (path === "/docs") {
    md = ["# relay docs", "", ...DOCS.map((d) => `- [${d.title}](${SITE_URL}/docs/${d.slug}): ${d.description}`), "", `Full text: ${SITE_URL}/llms-full.txt`, ""].join("\n");
  } else if (path.startsWith("/docs/")) md = docMarkdown(path.slice("/docs/".length));
  if (md == null) {
    return new NextResponse("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" } });
  }
  return new NextResponse(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      vary: "Accept",
      "cache-control": "public, max-age=300",
      link: `<${SITE_URL}${path}>; rel="canonical"; type="text/html"`,
    },
  });
}
