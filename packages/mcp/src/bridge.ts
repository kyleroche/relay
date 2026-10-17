/**
 * Site mode for the stdio server: a JSON-RPC pass-through from the CLI's stdio to the hosted site's `/mcp`. Every
 * message the CLI writes (`initialize`, `tools/list`, `tools/call`, pings, notifications) is POSTed to the site
 * unchanged with `Authorization: Bearer <access token>`, and whatever the site answers (results, tool errors, scope
 * refusals with their access hints, protocol errors) is written back unchanged. The tool set, descriptions and
 * server info the CLI sees are therefore the site's, and a decision recorded here lands where the workers' briefs
 * are compiled.
 *
 * The site's server is stateless Streamable HTTP (one JSON-RPC body per POST, no GET stream, `mcp-session-id` only
 * if it ever starts issuing one), so a POST per message is the whole transport; the SDK's client transport would add
 * its own result validation and OAuth handling on top, and the device-flow refresh here must stay the CLI's own.
 * `BridgeAuth` hands out the token and renews it: before a message when it is near expiry, and once more when the
 * site answers 401 to a token that looked valid (revoked, or rotated by another relay process on this machine).
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest, isJSONRPCRequest, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { canRefreshSiteToken, loadConfig, normalizeSite, refreshSiteToken, refreshSiteTokenIfStale, type HarnessConfig } from "@relay/core";

export interface BridgeAuth {
  /** The bearer to send now, renewed first when it is about to lapse. */
  token(): Promise<string>;
  /** The site answered 401 to `rejected`: a different token to retry with once, or undefined when there is none. */
  renew(rejected: string): Promise<string | undefined>;
}

export interface SiteBridgeOptions {
  site: string;
  auth: BridgeAuth;
  fetch?: typeof fetch;
  /** One line per noteworthy event (a renewed token, a refusal); the stdio server sends these to stderr. */
  log?: (line: string) => void;
}

export interface SiteBridge {
  readonly site: string;
  /**
   * Forward one message and return the site's answers in order: one result or error for a request, nothing for a
   * notification or a response. Never throws; a site that cannot be reached or refuses the token comes back as a
   * JSON-RPC error for the request's id.
   */
  forward(msg: JSONRPCMessage): Promise<JSONRPCMessage[]>;
}

/** JSON-RPC error codes the bridge itself produces (the site's own codes pass through). */
export const BRIDGE_UNREACHABLE = -32000;
export const BRIDGE_UNAUTHORIZED = -32001;

type RpcError = { jsonrpc: "2.0"; id: RequestId; error: { code: number; message: string; data?: unknown } };

/** The messages in a Streamable HTTP response body: one JSON object or array, or SSE events each carrying one. */
export function parseMcpBody(text: string, contentType: string | null): JSONRPCMessage[] {
  const t = text.trim();
  if (!t) return [];
  if (/text\/event-stream/i.test(contentType ?? "") || !t.startsWith("{") && !t.startsWith("[")) {
    const out: JSONRPCMessage[] = [];
    for (const event of t.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data) as JSONRPCMessage | JSONRPCMessage[];
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    return out;
  }
  const parsed = JSON.parse(t) as JSONRPCMessage | JSONRPCMessage[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The `error.message` of a JSON-RPC error body, when the body is one (the site's 401 says how to get access). */
function errorOf(text: string): { message: string; data?: unknown } | undefined {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown; data?: unknown } };
    if (j && typeof j.error?.message === "string") return { message: j.error.message, ...(j.error.data !== undefined ? { data: j.error.data } : {}) };
  } catch {
    /* not JSON */
  }
  return undefined;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSiteBridge(opts: SiteBridgeOptions): SiteBridge {
  const site = normalizeSite(opts.site);
  const doFetch = opts.fetch ?? fetch;
  let protocolVersion: string | undefined;
  let sessionId: string | undefined;

  const post = (msg: JSONRPCMessage, token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "relay-mcp",
    };
    // the version negotiated at initialize travels on every later request, as the SDK's own client does
    if (protocolVersion && !isInitializeRequest(msg)) headers["mcp-protocol-version"] = protocolVersion;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return doFetch(`${site}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
  };

  return {
    site,
    async forward(msg) {
      const id: RequestId | undefined = isJSONRPCRequest(msg) ? msg.id : undefined;
      const fail = (code: number, message: string, data?: unknown): JSONRPCMessage[] => (id === undefined ? [] : [{ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } } satisfies RpcError]);

      let token: string;
      try {
        token = await opts.auth.token();
      } catch (e) {
        return fail(BRIDGE_UNAUTHORIZED, `relay-mcp: no usable token for ${site}: ${describe(e)}`);
      }
      let res: Response;
      let renewFailure = "";
      try {
        res = await post(msg, token);
        if (res.status === 401) {
          let next: string | undefined;
          try {
            next = await opts.auth.renew(token);
          } catch (e) {
            renewFailure = describe(e);
          }
          if (next) {
            opts.log?.(`${site} refused the token (401); renewed it and retrying`);
            res = await post(msg, next);
          }
        }
      } catch (e) {
        return fail(BRIDGE_UNREACHABLE, `relay-mcp: cannot reach ${site}/mcp: ${describe(e)}`);
      }
      const text = await res.text();
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (res.status === 401) {
        const err = errorOf(text);
        opts.log?.(`${site} refused the token (401)${renewFailure ? `; renewing it failed: ${renewFailure}` : ""}`);
        return fail(BRIDGE_UNAUTHORIZED, `${err?.message ?? `relay-mcp: ${site} refused the token (401)`}${renewFailure ? ` Renewing the token failed: ${renewFailure}` : ""}`, err?.data);
      }
      if (!res.ok) {
        // the site's JSON-RPC error (id null on an HTTP-level refusal) is re-addressed to the request; anything else is summarised
        const err = errorOf(text);
        return fail(BRIDGE_UNREACHABLE, err?.message ?? `relay-mcp: ${site}/mcp answered HTTP ${res.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}`, err?.data);
      }
      let out: JSONRPCMessage[];
      try {
        out = parseMcpBody(text, res.headers.get("content-type"));
      } catch (e) {
        return fail(BRIDGE_UNREACHABLE, `relay-mcp: unreadable answer from ${site}/mcp: ${describe(e)}`);
      }
      if (isInitializeRequest(msg)) {
        for (const m of out) {
          const v = (m as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
          if (typeof v === "string") protocolVersion = v;
        }
      }
      return out;
    },
  };
}

/**
 * Serve a transport (stdio in the server) through the bridge: every incoming message is forwarded and the answers
 * written back. Requests run concurrently, as the site's stateless server allows; JSON-RPC pairs answers by id.
 */
export async function serveSiteBridge(transport: Transport, bridge: SiteBridge, onError?: (e: unknown) => void): Promise<{ drain(): Promise<void> }> {
  const inFlight = new Set<Promise<void>>();
  transport.onmessage = (msg) => {
    const p: Promise<void> = bridge
      .forward(msg)
      .then(async (out) => {
        for (const m of out) await transport.send(m);
      })
      .catch((e) => onError?.(e))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };
  transport.onerror = (e) => onError?.(e);
  await transport.start();
  return {
    /** Resolves once every message received so far has been answered (stdin closed: finish, then exit). */
    async drain() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * One cheap `tools/list` against the site, as the bridge would send it: what `relay doctor` runs to say the installed
 * MCP entry will answer. Throws with the site's message when the token is refused or the site is down.
 */
export async function listSiteTools(opts: { site: string; token: string; fetch?: typeof fetch }): Promise<{ tools: string[] }> {
  const bridge = createSiteBridge({ site: opts.site, auth: { token: async () => opts.token, renew: async () => undefined }, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const [answer] = await bridge.forward({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  if (!answer) throw new Error(`${bridge.site}/mcp returned no answer to tools/list`);
  if ("error" in answer) throw new Error(answer.error.message);
  const tools = ((answer as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((t) => t.name);
  return { tools };
}

/** How the site-mode server names its credential in logs: the token's name, never the token. */
export const tokenLabel = (cfg: Pick<HarnessConfig, "siteTokenName" | "siteTokenSource">): string =>
  cfg.siteTokenName ?? ({ device: "an unnamed device-flow token", invite: "an unnamed invite token", manual: "a pasted token", env: "RELAY_TOKEN" } as const)[cfg.siteTokenSource ?? "manual"];

/**
 * The bridge's credential source. The server is long-lived while hooks and CLI commands come and go, and a refresh
 * rotates the refresh token, so before spending ours the credential on disk is read again: whoever renewed it last
 * wins, and a 401 to a token another process already replaced is answered with theirs, not with a doomed refresh.
 */
export function siteAuth(initial: HarnessConfig): BridgeAuth {
  let cfg = initial;
  const reload = (): HarnessConfig => {
    const fresh = loadConfig();
    return fresh.site === cfg.site && fresh.siteToken ? fresh : cfg;
  };
  return {
    async token() {
      cfg = await refreshSiteTokenIfStale(reload());
      return cfg.siteToken!;
    },
    async renew(rejected) {
      cfg = reload();
      if (cfg.siteToken && cfg.siteToken !== rejected) return cfg.siteToken;
      if (!canRefreshSiteToken(cfg)) return undefined;
      cfg = await refreshSiteToken(cfg);
      return cfg.siteToken;
    },
  };
}
