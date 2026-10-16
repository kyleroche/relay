/**
 * Content negotiation for the pages that have Markdown mirrors, as pure functions so `proxy.ts` stays thin and the
 * tests can cover the decisions without booting Next.
 *
 * The homepage is two pages in one path: anonymous visitors get the public landing (HTML, or Markdown when the
 * Accept header prefers it); a signed-in viewer, and every request in mock mode, gets the feed as HTML regardless of
 * Accept. `homeDecision` makes that call; `negotiateFormat` makes the Accept call for every negotiated path.
 */

/**
 * Which page's Markdown /api/markdown should serve, as a request header set on the rewrite: the rewritten URL's query
 * does not reach the route handler in Next 16, the request headers do.
 */
export const MARKDOWN_PATH_HEADER = "x-relay-markdown-path";

/** Paths served as text/markdown on request. `/` only when the visitor is anonymous (see `homeDecision`). */
const NEGOTIATED = /^\/(info|about|contact|privacy|docs)(\/.*)?$/;

export function hasMarkdownMirror(pathname: string): boolean {
  return pathname === "/" || NEGOTIATED.test(pathname);
}

export type Format = "markdown" | "html" | "none";

interface Range {
  type: string;
  q: number;
}

export function parseAccept(header: string | null | undefined): Range[] {
  return (header ?? "*/*")
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

/** Markdown only when the client asks for it over HTML; `none` when it accepts neither (a 406). */
export function negotiateFormat(accept: string | null | undefined): Format {
  const ranges = parseAccept(accept);
  const md = quality(ranges, "text/markdown");
  const html = Math.max(quality(ranges, "text/html"), quality(ranges, "application/xhtml+xml"));
  if (md > 0 && md > html) return "markdown";
  if (md === 0 && html === 0) return "none";
  return "html";
}

export type HomeView = "feed" | "landing";

/** Who sees what at `/`: the feed for a signed-in viewer (and the demo in mock mode), the public landing otherwise. */
export function homeView(input: { signedIn: boolean; mock: boolean }): HomeView {
  return input.signedIn || input.mock ? "feed" : "landing";
}

export type HomeDecision = { view: "feed" } | { view: "landing"; format: Format };

/** The whole call for `/`: the feed ignores Accept (it is an app page); the landing negotiates like any public page. */
export function homeDecision(input: { signedIn: boolean; mock: boolean; accept: string | null | undefined }): HomeDecision {
  if (homeView(input) === "feed") return { view: "feed" };
  return { view: "landing", format: negotiateFormat(input.accept) };
}

/** The Markdown body an agent gets for a path that does not exist. Short, with the places that do. */
export function notFoundMarkdown(pathname: string, siteUrl: string): string {
  const safe = pathname.replace(/[`\r\n]/g, "").slice(0, 200);
  return [
    "# 404: nothing at this address",
    "",
    `There is no page or resource at \`${safe}\` on relay. Nothing was moved; the path was never served.`,
    "",
    "Places that exist:",
    "",
    `- [What relay is](${siteUrl}/): the public overview, also as Markdown with \`Accept: text/markdown\``,
    `- [Docs](${siteUrl}/docs): architecture, the API and MCP guide, versioning, agent readiness`,
    `- [OpenAPI](${siteUrl}/openapi.json) and the [API catalog](${siteUrl}/.well-known/api-catalog)`,
    `- [llms.txt](${siteUrl}/llms.txt) and [llms-full.txt](${siteUrl}/llms-full.txt)`,
    `- [About](${siteUrl}/about), [Contact](${siteUrl}/contact), [Privacy](${siteUrl}/privacy)`,
    "",
    "The feed, projects, usage, workers and assets need a signed-in session; agents use `/api/v1` and `/mcp` with a bearer token instead.",
    "",
  ].join("\n");
}
