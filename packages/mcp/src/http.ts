/**
 * Streamable HTTP for the web app: `createMcpHandler(db, opts)` returns a `(Request) => Promise<Response>` a Next.js
 * route can export as POST. Stateless: every request gets its own server and transport, so the bearer check decides
 * per request which scopes the tools run with.
 *
 * Anyone can connect. A request without a bearer runs a server that holds no scopes (plus the public read scopes when
 * `publicRead` is set), so `initialize`, `tools/list` and the always-public tools answer, and a scoped tool returns an
 * MCP tool error naming the scope it needs. A bearer the server does not recognise is refused with HTTP 401: the
 * caller meant to authenticate and did not.
 *
 * Two ways to recognise a token: `token` (one shared secret, RELAY_MEMORY_TOKEN, granting every scope) and
 * `authorize` (the app's own lookup: RELAY_API_TOKENS or the `tokens` table, returning the scopes it carries).
 */
import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db, TokenScope } from "@relay/core";
import { ALL_SCOPES, createRelayServer, type RelayServerOptions } from "./server.ts";

export interface Grant {
  scopes: TokenScope[];
  /** Attribution for writes made with this token, e.g. `token:ci`. */
  actor?: string;
}

export interface McpHandlerOptions extends Pick<RelayServerOptions, "embed" | "site" | "assets"> {
  /** A shared bearer token that grants every scope (RELAY_MEMORY_TOKEN). Unset or empty means it never matches. */
  token?: string | undefined;
  /** Resolve a presented bearer token to its scopes; undefined when unknown. */
  authorize?: (bearer: string) => Promise<Grant | undefined>;
  /** Grant the public read scopes (feed:read, memory:read) to callers without a token. Default false. */
  publicRead?: boolean;
  /** Attribution for writes made with the shared token. */
  actor?: string;
}

export type McpHandler = (req: Request) => Promise<Response>;

export function bearerOf(req: Request): string | undefined {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim();
}

export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The grant a request carries, or undefined for anonymous and unknown tokens. */
export async function resolveGrant(req: Request, opts: McpHandlerOptions): Promise<Grant | undefined> {
  const presented = bearerOf(req);
  if (!presented) return undefined;
  if (tokenMatches(presented, opts.token)) return { scopes: ALL_SCOPES, actor: opts.actor ?? "human:web" };
  if (opts.authorize) return opts.authorize(presented);
  return undefined;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: unknown bearer token" }, id: null }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="relay"' },
  });
}

export function createMcpHandler(db: Db, opts: McpHandlerOptions): McpHandler {
  return async (req) => {
    const presented = bearerOf(req);
    const grant = await resolveGrant(req, opts);
    if (presented && !grant) return unauthorized();
    const server = createRelayServer(db, {
      canWrite: false,
      scopes: grant?.scopes ?? [],
      publicRead: !!opts.publicRead,
      actor: grant?.actor ?? (grant ? opts.actor ?? "human:web" : "anon:web"),
      ...(opts.embed ? { embed: opts.embed } : {}),
      ...(opts.site ? { site: opts.site } : {}),
      ...(opts.assets ? { assets: opts.assets } : {}),
      invalidateCache: false,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // stateless: nothing to keep between requests
      void transport.close().catch(() => {});
    }
  };
}
