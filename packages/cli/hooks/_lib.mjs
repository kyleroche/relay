// Shared helpers for the relay hook scripts. Plain Node ESM with no dependencies, because a hook runs on every
// session start and prompt: it must answer fast and must never break the session. The heavy work (PGlite, the
// brief compiler) lives in the CLI, which these scripts spawn (dist/relay.js, or the repo's own tsx) only when the cache misses.
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
/** In the published package the hooks sit at dist/hooks beside the bundled CLI, dist/relay.js. */
export const BUNDLED_CLI = resolve(HOOKS_DIR, "..", "relay.js");
/** In a checkout they sit at packages/cli/hooks and the CLI is TypeScript, run through the repo's tsx. */
export const RELAY_ROOT = resolve(HOOKS_DIR, "..", "..", "..");
export const CLI_MAIN = join(RELAY_ROOT, "packages", "cli", "src", "main.ts");
export const RELAY_HOME = process.env.RELAY_HOME ?? join(homedir(), ".harness");
export const BRIEF_TTL_MS = 10 * 60_000;

/** `--cli <name>` from argv; the CLI the hook was installed for. */
export function cliName() {
  const i = process.argv.indexOf("--cli");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "claude";
}

/** Read the hook payload from stdin (JSON, or nothing). Never blocks for more than a moment. */
export function readPayload() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Nearest ancestor of `cwd` holding .relay/rules.json, and the slug it names. Null when the repo is not linked. */
export function linkedProject(cwd) {
  let dir = resolve(cwd || process.cwd());
  for (;;) {
    const p = join(dir, ".relay", "rules.json");
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        return j && typeof j.project === "string" ? { root: dir, project: j.project } : null;
      } catch {
        return null;
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const safe = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60);

/** Same layout as packages/core/src/hooks/cache.ts: <RELAY_HOME>/cache/brief/<project>-<sha(key)[0:12]>.json */
export function briefCachePath(project, key) {
  return join(RELAY_HOME, "cache", "brief", `${safe(project)}-${sha256(key).slice(0, 12)}.json`);
}

/** Same key as packages/cli/src/commands/brief.ts briefCacheKey(). */
export const briefCacheKey = (intent, maxTokens, model = "", lane = "") => `${intent}|${maxTokens}|${model}|${lane}`;

export function readCachedBrief(project, key) {
  const p = briefCachePath(project, key);
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Date.now() - j.ts > BRIEF_TTL_MS ? undefined : j;
  } catch {
    return undefined;
  }
}

/** The command line that runs the relay CLI with this node: dist/relay.js in the package; the repo's tsx and packages/cli/src/main.ts in a checkout. */
export function relayArgv(args) {
  if (existsSync(BUNDLED_CLI)) return [process.execPath, [BUNDLED_CLI, ...args]];
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  return [process.execPath, [tsx, CLI_MAIN, ...args]];
}

/** Run the relay CLI synchronously; returns stdout ("" on any failure or timeout). */
export function runRelay(args, timeoutMs) {
  const [bin, argv] = relayArgv(args);
  const r = spawnSync(bin, argv, { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, RELAY_HOOK: "1" }, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) {
    if (process.env.RELAY_HOOK_DEBUG) process.stderr.write(`[relay hook] ${r.error ? r.error.message : `exit ${r.status}`}: ${(r.stderr || "").slice(0, 500)}\n`);
    return "";
  }
  return r.stdout || "";
}

/** Start the relay CLI detached, output appended to <RELAY_HOME>/cache/<logName>; the hook returns at once. */
export function spawnRelayDetached(args, logName) {
  const dir = join(RELAY_HOME, "cache");
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, logName), "a");
  const [bin, argv] = relayArgv(args);
  const child = spawn(bin, argv, { detached: true, stdio: ["ignore", out, out], env: { ...process.env, RELAY_HOOK: "1" } });
  child.unref();
  return child.pid;
}
