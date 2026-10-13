/**
 * Streamable HTTP for the web app: `createMcpHandler(db, {token})` returns a `(Request) => Promise<Response>` a
 * Next.js route can export as GET/POST/DELETE. Stateless: every request gets its own server and transport, so the
 * bearer check decides per request whether write tools are enabled. Without a valid token the request is refused
 * (401) unless `publicRead` is set, in which case a read-only server answers.
 */
import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CompileBriefOptions, Db } from "@relay/core";
import { createRelayServer } from "./server.ts";

export interface McpHandlerOptions {
  /** Bearer token required for write tools (RELAY_MEMORY_TOKEN). Unset or empty means writes are never allowed. */
  token?: string | undefined;
  /** Serve read tools to unauthenticated callers. Default false: no token, no answer. */
  publicRead?: boolean;
  /** Attribution for writes made through this handler. */
  actor?: string;
  embed?: CompileBriefOptions["embed"];
}

export type McpHandler = (req: Request) => Promise<Response>;

function bearerOf(req: Request): string | undefined {
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

export function createMcpHandler(db: Db, opts: McpHandlerOptions): McpHandler {
  return async (req) => {
    const authed = tokenMatches(bearerOf(req), opts.token);
    if (!authed && !opts.publicRead) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="relay"' },
      });
    }
    const server = createRelayServer(db, { canWrite: authed, actor: opts.actor ?? (authed ? "human:web" : "anon:web"), ...(opts.embed ? { embed: opts.embed } : {}), invalidateCache: false });
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
