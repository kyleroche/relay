import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { bearer, clientKey, problem, rateHeaders, requireScope, takeToken } from "@/lib/api";
import { getFeed, getProject } from "@/lib/data";
import { infoDocument, methodologyText, APP_VERSION } from "@/lib/info-doc";
import { sanitizeEvent } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

/**
 * MCP over Streamable HTTP, stateless: one server + transport per request, JSON responses.
 * Public read-only tools back onto the same data layer as the site; memory tools need a bearer token.
 */
function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function denied(req: Request, scope: "memory:read" | "memory:write", tool: string) {
  const res = requireScope(req, scope, `/mcp#${tool}`);
  if (!res) return null;
  return { isError: true, content: [{ type: "text" as const, text: `${res.status} ${res.status === 401 ? "Unauthorized" : "Forbidden"}: ${tool} needs a bearer token with the ${scope} scope. See /docs/api#authentication-and-scopes.` }] };
}

function buildServer(req: Request): McpServer {
  const server = new McpServer({ name: "relay", version: APP_VERSION });

  server.registerTool(
    "relay_get_info",
    { title: "Describe relay", description: "Name, version, the five rules, a task's life, data mode and links to every machine-readable surface.", inputSchema: {} },
    async () => text(infoDocument()),
  );

  server.registerTool(
    "relay_get_feed",
    {
      title: "Read the feed",
      description: "Events newest first. Filter by project, kind, actor or lane; page with before/after ISO timestamps. Payload and dedupe keys are omitted.",
      inputSchema: {
        project: z.string().optional(),
        kind: z.string().optional(),
        actor: z.string().optional(),
        lane: z.enum(["claude", "codex", "grok"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        after: z.string().datetime({ offset: true }).optional(),
      },
    },
    async (args) => {
      const events = await getFeed({ ...args, limit: args.limit ?? 50 });
      return text({ events: events.map(sanitizeEvent), count: events.length });
    },
  );

  server.registerTool(
    "relay_get_project",
    { title: "Read a project", description: "One project by slug with current decisions, models in use and recent events.", inputSchema: { slug: z.string().min(1) } },
    async ({ slug }) => {
      const p = await getProject(slug);
      if (!p) return { isError: true, content: [{ type: "text" as const, text: `No project with slug '${slug}'.` }] };
      return text({ ...p, events: p.events.slice(0, 30).map(sanitizeEvent) });
    },
  );

  server.registerTool(
    "relay_get_methodology",
    { title: "How relay works", description: "The five rules and a task's life as plain text, for briefing another agent.", inputSchema: {} },
    async () => text(methodologyText()),
  );

  server.registerTool(
    "relay_recall",
    { title: "Recall memory", description: "Search decisions and vendor guidance. Requires memory:read.", inputSchema: { query: z.string().min(1), project: z.string().optional() } },
    async ({ query, project }) => {
      const d = denied(req, "memory:read", "relay_recall");
      if (d) return d;
      // TODO(db): call @relay/core memory recall once the storage port lands.
      return text({ query, project: project ?? null, results: [], note: "Recall is not wired to storage yet." });
    },
  );

  server.registerTool(
    "relay_capture_decision",
    {
      title: "Capture a decision",
      description: "Record a durable decision for a project. Requires memory:write.",
      inputSchema: { project: z.string().min(1), text: z.string().min(1), source: z.string().optional(), source_ref: z.string().optional() },
    },
    async (args) => {
      const d = denied(req, "memory:write", "relay_capture_decision");
      if (d) return d;
      // TODO(db): insert through @relay/core decisions once the storage port lands.
      return text({ accepted: false, note: "Decision capture is not wired to storage yet.", received: args });
    },
  );

  return server;
}

export async function POST(req: NextRequest) {
  const rate = takeToken(clientKey(req));
  if (rate.limited) return problem(429, "Too Many Requests", "Rate limit exceeded.", "/mcp", {}, { ...rateHeaders(rate), "Retry-After": String(rate.resetSeconds) });
  const server = buildServer(req);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const token = bearer(req);
  const res = await transport.handleRequest(req, token ? { authInfo: { token, clientId: "bearer", scopes: [] } } : undefined);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(rateHeaders(rate))) headers.set(k, v);
  return new NextResponse(res.body, { status: res.status, headers });
}

/** Stateless server: no standalone SSE stream, no sessions to delete. */
export function GET() {
  return problem(405, "Method Not Allowed", "This MCP server is stateless: POST JSON-RPC to /mcp. See /.well-known/mcp/server-card.json.", "/mcp", {}, { Allow: "POST" });
}

export const DELETE = GET;
