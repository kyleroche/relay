/**
 * Brief cache for hooks. Session-start hooks must answer in well under a second, so `relay brief --hook` keeps the
 * rendered brief per (project, intent, cap) under ~/.harness/cache/brief/ for ten minutes. `relay decide` and
 * `relay prefer` invalidate a project's entries so a fresh decision reaches the next session at once.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../util.ts";

export const BRIEF_CACHE_TTL_MS = 10 * 60_000;

export function relayHome(): string {
  return process.env.RELAY_HOME ?? join(homedir(), ".harness");
}

export function briefCacheDir(home: string = relayHome()): string {
  return join(home, "cache", "brief");
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60);

export function briefCachePath(project: string, key: string, home?: string): string {
  return join(briefCacheDir(home), `${safe(project)}-${sha256(key).slice(0, 12)}.json`);
}

export interface CachedBrief {
  ts: number;
  project: string;
  key: string;
  text: string;
  tokens: number;
}

export function readCachedBrief(project: string, key: string, opts: { home?: string; ttlMs?: number } = {}): CachedBrief | undefined {
  const p = briefCachePath(project, key, opts.home);
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as CachedBrief;
    if (Date.now() - j.ts > (opts.ttlMs ?? BRIEF_CACHE_TTL_MS)) return undefined;
    return j;
  } catch {
    return undefined;
  }
}

export function writeCachedBrief(entry: Omit<CachedBrief, "ts">, home?: string): string {
  const dir = briefCacheDir(home);
  mkdirSync(dir, { recursive: true });
  const p = briefCachePath(entry.project, entry.key, home);
  writeFileSync(p, JSON.stringify({ ...entry, ts: Date.now() }));
  return p;
}

/** Drop every cached brief for a project (or all projects when omitted). Returns the number removed. */
export function invalidateBriefCache(project?: string, home?: string): number {
  const dir = briefCacheDir(home);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    if (project && !f.startsWith(`${safe(project)}-`)) continue;
    rmSync(join(dir, f), { force: true });
    n++;
  }
  return n;
}
