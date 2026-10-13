/**
 * Configuration comes from two places only: the environment for anything secret or deployment-specific
 * (`DATABASE_URL`, `AI_GATEWAY_API_KEY`) and ~/.harness/config.json for preferences (`staleDays`, the embedding
 * model). Nothing is read from other tools' config files.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayConfig {
  apiKey?: string;
  embeddingModel: string;
  embeddingDim: number;
}

export interface HarnessConfig {
  home: string;
  configPath: string;
  skillsDir: string;
  stateDir: string;
  /** Postgres connection string (env DATABASE_URL). Unset means embedded PGlite at dbFile. */
  databaseUrl?: string;
  /** PGlite data directory used when databaseUrl is unset. */
  dbFile: string;
  gateway: GatewayConfig;
  /** Days before a model's onboarding is considered stale. */
  staleDays: number;
}

/** The subset a user may put in ~/.harness/config.json. */
export interface FileConfig {
  staleDays?: number;
  gateway?: { embeddingModel?: string; embeddingDim?: number };
}

const HOME = process.env.RELAY_HOME ?? join(homedir(), ".harness");

export function defaultConfig(): HarnessConfig {
  return {
    home: HOME,
    configPath: join(HOME, "config.json"),
    skillsDir: join(HOME, "skills"),
    stateDir: join(HOME, "state"),
    dbFile: join(HOME, "relay.pglite"),
    gateway: { embeddingModel: "openai/text-embedding-3-small", embeddingDim: 1536 },
    staleDays: 30,
  };
}

export function loadConfig(): HarnessConfig {
  const cfg = defaultConfig();
  if (existsSync(cfg.configPath)) {
    const file = JSON.parse(readFileSync(cfg.configPath, "utf8")) as FileConfig;
    if (typeof file.staleDays === "number") cfg.staleDays = file.staleDays;
    if (file.gateway?.embeddingModel) cfg.gateway.embeddingModel = file.gateway.embeddingModel;
    if (typeof file.gateway?.embeddingDim === "number") cfg.gateway.embeddingDim = file.gateway.embeddingDim;
  }
  if (process.env.DATABASE_URL) cfg.databaseUrl = process.env.DATABASE_URL;
  if (process.env.AI_GATEWAY_API_KEY) cfg.gateway.apiKey = process.env.AI_GATEWAY_API_KEY;
  return cfg;
}

export function ensureHome(cfg: HarnessConfig): void {
  for (const d of [cfg.home, cfg.skillsDir, cfg.stateDir]) mkdirSync(d, { recursive: true });
}
