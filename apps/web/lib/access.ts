/**
 * Which requests need a signed-in viewer. One pure function, used by `proxy.ts` and covered by tests; the table in
 * docs/SECURITY.md ("Signing in to the web app") is the human-readable copy of what is below.
 *
 * Public without a session: the homepage (the public landing for anonymous visitors, the feed for a signed-in one;
 * `lib/negotiate.ts` decides which), the agent-readiness surface (info, about, contact, privacy, docs, well-known
 * files, OpenAPI, llms.txt, the install skill), the sign-in flow itself, the endpoints that carry their own
 * authentication (/mcp and /api/v1 bearer tokens, webhook and cron secrets, signed asset URLs), and anonymous /api/v1
 * reads when the deploy enables public read. The app's own pages — projects, usage, workers, the asset pages, the
 * internal /api/feed and /api/meters routes — and /api/v1 calls without a bearer need a session. Paths that are
 * neither are `unknown`: they fall through so Next.js answers 404. Agents and scanners must see a real not-found,
 * never a redirect to sign-in (docs/AGENT-READINESS.md).
 */

export type Access = "public" | "session" | "unknown";

export interface AccessInput {
  /** The request carries an `Authorization: Bearer` header; the route's own token rules then apply. */
  hasBearer: boolean;
  /** `publicReadEnabled()`: anonymous /api/v1 reads are allowed (the route still checks scopes). */
  publicRead: boolean;
  method?: string;
}

const PUBLIC_EXACT = new Set([
  "/",
  "/info",
  "/about",
  "/contact",
  "/privacy",
  "/docs",
  "/sign-in",
  "/api/v1/info",
  "/openapi.json",
  "/server.json",
  "/robots.txt",
  "/sitemap.xml",
  "/mcp",
  "/api/markdown",
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
]);

const PUBLIC_PREFIXES = [
  "/docs/",
  "/auth/",
  "/.well-known/",
  "/skills/",
  "/api/webhooks/",
  "/api/cron/",
  "/api/assets/stream",
  "/api/assets/bundle/",
  "/api/assets/upload",
  "/_next/",
  "/opengraph-image",
  "/twitter-image",
];

const PUBLIC_PATTERNS = [/^\/llms[^/]*\.txt$/, /^\/manifest[^/]*$/];

/** The signed-in surface. Add a page here when you add one; anything not listed is a 404, not a redirect. */
const SESSION_EXACT = new Set(["/projects", "/usage", "/workers", "/assets", "/tokens", "/api/feed", "/api/meters"]);
const SESSION_PREFIXES = ["/projects/", "/assets/", "/api/assets/mock/"];

/** True for the paths whose denial is a problem+json 401 rather than a redirect to /sign-in. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/mcp";
}

export function classifyRoute(pathname: string, input: AccessInput): Access {
  const path = normalize(pathname);
  if (PUBLIC_EXACT.has(path)) return "public";
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return "public";
  if (PUBLIC_PATTERNS.some((re) => re.test(path))) return "public";
  if (path.startsWith("/api/v1/")) {
    if (input.hasBearer) return "public";
    const method = (input.method ?? "GET").toUpperCase();
    if (input.publicRead && (method === "GET" || method === "HEAD")) return "public";
    return "session";
  }
  if (SESSION_EXACT.has(path) || SESSION_PREFIXES.some((p) => path.startsWith(p))) return "session";
  return "unknown";
}

function normalize(pathname: string): string {
  let p = pathname;
  // collapse repeated slashes and drop a trailing one so "/docs/" and "//info" classify like their canonical form
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

/** A `next` query value is only honoured when it is a path on this site. */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  if (next.startsWith("/sign-in") || next.startsWith("/auth/")) return fallback;
  return next;
}
