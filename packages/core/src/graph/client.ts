import type { GraphConfig } from "../config.ts";

export type Params = Record<string, unknown>;
export interface QueryResult<T> {
  rows: T[];
  stats: string[];
}
export interface QueryOpts {
  readOnly?: boolean;
}

export interface GraphClient {
  readonly graphName: string;
  query<T = Record<string, unknown>>(cypher: string, params?: Params, opts?: QueryOpts): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

export class GraphError extends Error {
  constructor(message: string, readonly cypher: string) {
    super(message);
    this.name = "GraphError";
  }
}

/** Talks to FalkorDB through an MCP server exposing `query_graph` (the fleet-memory server). */
export class McpGraphClient implements GraphClient {
  private client: import("@modelcontextprotocol/sdk/client/index.js").Client | undefined;
  constructor(readonly graphName: string, private readonly url: string, private readonly token?: string) {}

  private async connect() {
    if (this.client) return this.client;
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const headers: Record<string, string> = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    const client = new Client({ name: "relay", version: "0.0.1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } }));
      this.client = client;
      return client;
    } catch (e) {
      // legacy SSE transport fallback
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const c2 = new Client({ name: "relay", version: "0.0.1" });
      await c2.connect(new SSEClientTransport(new URL(this.url), { requestInit: { headers } }));
      this.client = c2;
      return c2;
    }
  }

  async query<T = Record<string, unknown>>(cypher: string, params?: Params, opts?: QueryOpts): Promise<QueryResult<T>> {
    const c = await this.connect();
    const args: Record<string, unknown> = { graphName: this.graphName, query: cypher, readOnly: opts?.readOnly ?? false };
    if (params && Object.keys(params).length) args.params = params;
    const res = await c.callTool({ name: "query_graph", arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((x) => x.type === "text")?.text ?? "";
    if (res.isError) throw new GraphError(text || "query failed", cypher);
    let parsed: { data?: T[]; metadata?: string[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GraphError(`unparseable graph result: ${text.slice(0, 300)}`, cypher);
    }
    return { rows: parsed.data ?? [], stats: parsed.metadata ?? [] };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

/** Direct FalkorDB (redis protocol) client. Faster; needs the redis password. */
export class RedisGraphClient implements GraphClient {
  private db: import("falkordb").FalkorDB | undefined;
  constructor(readonly graphName: string, private readonly url: string) {}

  private async graph() {
    if (!this.db) {
      const { FalkorDB } = await import("falkordb");
      this.db = await FalkorDB.connect({ url: this.url });
    }
    return this.db.selectGraph(this.graphName);
  }

  async query<T = Record<string, unknown>>(cypher: string, params?: Params, opts?: QueryOpts): Promise<QueryResult<T>> {
    const g = await this.graph();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = opts?.readOnly ? await g.roQuery(cypher, { params: params as never }) : await g.query(cypher, { params: params as never });
      const stats: string[] = Array.isArray(r?.metadata) ? r.metadata.map(String) : [];
      return { rows: (r?.data ?? []) as T[], stats };
    } catch (e) {
      throw new GraphError(e instanceof Error ? e.message : String(e), cypher);
    }
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }
}

export function createGraphClient(cfg: GraphConfig): GraphClient {
  if (cfg.transport === "redis") {
    if (!cfg.redisUrl) throw new Error("graph.redisUrl is required for the redis transport");
    return new RedisGraphClient(cfg.name, cfg.redisUrl);
  }
  if (!cfg.mcpUrl) throw new Error("graph.mcpUrl is required for the mcp transport (or add fleet-memory to ~/.claude.json)");
  return new McpGraphClient(cfg.name, cfg.mcpUrl, cfg.mcpToken);
}
