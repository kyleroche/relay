/**
 * One `tools/call` on relay's MCP server, for code that runs outside a model turn (the usage hook). The model's own
 * calls go through the eve connection in `agent/connections/relay.ts`; a hook has no connection to call through.
 *
 * relay's `/mcp` is stateless Streamable HTTP: one JSON-RPC body per POST, no session to open first, and it may
 * answer as JSON or as a single server-sent event. That is the whole protocol this needs, so there is no client here.
 */

export interface RelayEndpoint {
  site: string;
  token: string;
}

export type RelayCallResult = { ok: true; text: string } | { ok: false; error: string };

interface RpcReply {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

/** The JSON-RPC reply in a response body: plain JSON, or the `data:` line of an event stream. */
export function parseRpcReply(body: string, contentType: string | null): RpcReply | undefined {
  const raw = /text\/event-stream/i.test(contentType ?? "")
    ? body
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n")
    : body.trim();
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof one === "object" && one !== null ? (one as RpcReply) : undefined;
  } catch {
    return undefined;
  }
}

export async function callRelayTool(
  relay: RelayEndpoint,
  name: string,
  args: Record<string, unknown>,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RelayCallResult> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${relay.site}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relay.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      // a redirect would carry the token to another origin
      redirect: "error",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    return { ok: false, error: `relay could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = await res.text().catch(() => "");
  const reply = parseRpcReply(body, res.headers.get("content-type"));
  if (!res.ok) return { ok: false, error: reply?.error?.message ?? `relay answered HTTP ${res.status}` };
  if (!reply) return { ok: false, error: "relay's answer was not JSON-RPC" };
  if (reply.error) return { ok: false, error: reply.error.message ?? "relay returned a JSON-RPC error" };
  const text = (reply.result?.content ?? []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
  // a tool's own refusal (a missing scope, an unknown project) comes back as a result marked isError
  return reply.result?.isError ? { ok: false, error: text || `${name} failed` } : { ok: true, text };
}
