import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GraphConfig {
  name: string;
  transport: "mcp" | "redis";
  /** MCP transport: streamable-HTTP MCP server exposing query_graph (the fleet-memory server on the Mac mini). */
  mcpUrl?: string;
  mcpToken?: string;
  /** Redis transport: redis://[:password@]host:port */
  redisUrl?: string;
}

export interface GatewayConfig {
  apiKey?: string;
  embeddingModel: string;
  embeddingDim: number;
}

export interface HarnessConfig {
  home: string;
  configPath: string;
  skillsDir: string;
  ledgerPath: string;
  stateDir: string;
  graph: GraphConfig;
  gateway: GatewayConfig;
  /** Days before a Model's onboarding is considered stale. */
  staleDays: number;
}

const HOME = process.env.RELAY_HOME ?? join(homedir(), ".harness");

export function defaultConfig(): HarnessConfig {
  return {
    home: HOME,
    configPath: join(HOME, "config.json"),
    skillsDir: join(HOME, "skills"),
    ledgerPath: join(HOME, "ledger.sqlite"),
    stateDir: join(HOME, "state"),
    graph: { name: "harness", transport: "mcp" },
    gateway: { embeddingModel: "openai/text-embedding-3-small", embeddingDim: 1536 },
    staleDays: 30,
  };
}

/**
 * Fallback discovery of the graph MCP endpoint from Claude Code's own config (~/.claude.json,
 * mcpServers["fleet-memory"]). Lets the harness reach the Mac mini without copying the token anywhere.
 */
export function discoverFleetMcp(): { url: string; token?: string } | undefined {
  try {
    const p = join(homedir(), ".claude.json");
    if (!existsSync(p)) return undefined;
    const j = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> };
    const s = j.mcpServers?.["fleet-memory"];
    if (!s?.url) return undefined;
    const auth = s.headers?.["Authorization"] ?? s.headers?.["authorization"];
    const token = auth?.replace(/^Bearer\s+/i, "");
    return token ? { url: s.url, token } : { url: s.url };
  } catch {
    return undefined;
  }
}

export function loadConfig(): HarnessConfig {
  const cfg = defaultConfig();
  if (existsSync(cfg.configPath)) {
    const file = JSON.parse(readFileSync(cfg.configPath, "utf8")) as Partial<HarnessConfig>;
    Object.assign(cfg, { ...file, graph: { ...cfg.graph, ...file.graph }, gateway: { ...cfg.gateway, ...file.gateway } });
  }
  // env overrides
  if (process.env.RELAY_GRAPH_MCP_URL) cfg.graph.mcpUrl = process.env.RELAY_GRAPH_MCP_URL;
  if (process.env.RELAY_GRAPH_MCP_TOKEN) cfg.graph.mcpToken = process.env.RELAY_GRAPH_MCP_TOKEN;
  if (process.env.RELAY_GRAPH_REDIS_URL) {
    cfg.graph.redisUrl = process.env.RELAY_GRAPH_REDIS_URL;
    cfg.graph.transport = "redis";
  }
  if (process.env.AI_GATEWAY_API_KEY) cfg.gateway.apiKey = process.env.AI_GATEWAY_API_KEY;
  // fill MCP endpoint from Claude Code's fleet-memory entry when not set explicitly
  if (cfg.graph.transport === "mcp" && (!cfg.graph.mcpUrl || !cfg.graph.mcpToken)) {
    const d = discoverFleetMcp();
    if (d) {
      cfg.graph.mcpUrl ??= d.url;
      cfg.graph.mcpToken ??= d.token;
    }
  }
  return cfg;
}

export function ensureHome(cfg: HarnessConfig): void {
  for (const d of [cfg.home, cfg.skillsDir, cfg.stateDir]) mkdirSync(d, { recursive: true });
}
