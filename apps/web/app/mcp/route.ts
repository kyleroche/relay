import { createMcpHandler, type Grant } from "@relay/mcp";
import { NextResponse, type NextRequest } from "next/server";
import { bearerChallenge, clientKey, problem, rateHeaders, RESOURCE_METADATA_URL, takeToken } from "@/lib/api";
import { getStore, publicUploadUrl, publicViewUrl, VIEW_TTL } from "@/lib/assets";
import { resolveGrant } from "@/lib/auth";
import { dataMode, getFeed, getProject, publicReadEnabled, SITE_URL } from "@/lib/data";
import { getDb, getMemoryDb } from "@/lib/db";
import { dispatchOne } from "@/lib/dispatch";
import { siteGitHub } from "@/lib/integrations";
import { infoDocument, methodologyText } from "@/lib/info-doc";
import { sanitizeEvent } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

/**
 * MCP over Streamable HTTP, stateless: the shared server from @relay/mcp (one tool set for stdio and HTTP) with
 * this site's documents plugged in. Anyone can connect, initialize and list tools; relay_get_info and
 * relay_get_methodology always answer. The feed and project read tools answer anonymously when public read is on;
 * everything else runs with the bearer token's scopes (RELAY_MEMORY_TOKEN, RELAY_API_TOKENS, or the tokens table)
 * and, without them, returns an MCP tool error naming the missing scope. Only an unrecognised bearer is an HTTP 401.
 * In mock mode the memory tools run against an empty in-memory database so the surface stays identical.
 */
async function handler(req: Request): Promise<Response> {
  const db = dataMode() === "db" ? await getDb() : await getMemoryDb();
  const mcp = createMcpHandler(db, {
    token: process.env.RELAY_MEMORY_TOKEN,
    authorize: async (bearer): Promise<Grant | undefined> => {
      const g = await resolveGrant(bearer);
      return g ? { scopes: g.scopes, actor: g.actor, name: g.name, expiresAt: g.expiresAt, source: g.source } : undefined;
    },
    publicRead: publicReadEnabled(),
    resourceMetadata: RESOURCE_METADATA_URL,
    authorizationServer: `${SITE_URL}/.well-known/oauth-authorization-server`,
    ...(dataMode() === "db" ? { github: await siteGitHub(), afterEvent: dispatchOne } : {}),
    site: {
      info: infoDocument,
      methodology: methodologyText,
      feed: async (opts) => {
        const events = await getFeed(opts);
        return { events: events.map(sanitizeEvent), count: events.length };
      },
      project: async (slug) => {
        const p = await getProject(slug);
        return p ? { ...p, events: p.events.slice(0, 30).map(sanitizeEvent) } : null;
      },
    },
    ...(dataMode() === "db"
      ? { assets: { store: getStore(), ttl: VIEW_TTL, viewUrl: (u: string, k: string) => publicViewUrl(u, k, true), uploadUrl: (u: string, k: string) => publicUploadUrl(u, k, true) } }
      : {}),
  });
  return mcp(req);
}

export async function POST(req: NextRequest) {
  const rate = takeToken(clientKey(req));
  if (rate.limited) return problem(429, "Too Many Requests", "Rate limit exceeded.", "/mcp", {}, { ...rateHeaders(rate), "Retry-After": String(rate.resetSeconds) });
  const res = await handler(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(rateHeaders(rate))) headers.set(k, v);
  if (res.status === 401) headers.set("WWW-Authenticate", bearerChallenge());
  return new NextResponse(res.body, { status: res.status, headers });
}

/** Stateless server: no standalone SSE stream, no sessions to delete. Rate-limit headers travel on every answer. */
export function GET(req: NextRequest) {
  const rate = takeToken(clientKey(req));
  return problem(405, "Method Not Allowed", "This MCP server is stateless: POST JSON-RPC to /mcp. See /.well-known/mcp/server-card.json.", "/mcp", {}, { Allow: "POST", ...rateHeaders(rate) });
}

export const DELETE = GET;
