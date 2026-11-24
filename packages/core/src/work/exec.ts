/**
 * Running a project's own commands for a job (its profile's `setup` and `verify`, docs/PROFILE.md) without a model
 * and without trusting them: each runs under the same OS sandbox the Claude lane's Bash runs in, through Anthropic's
 * sandbox runtime (`srt`: Seatbelt on macOS, bubblewrap on Linux). A command and everything it starts may write only
 * inside the clone and the package caches, may not read the credential paths, and may reach only the allowed hosts.
 * `npm ci` runs every dependency's install script, so this is not optional on a machine that holds the owner's logins.
 *
 * `--no-sandbox` on a host does not turn this off: it is about the Claude lane's Bash. The commands run directly only
 * where something else is the boundary and the runtime cannot start inside it: relay's container without a nested
 * sandbox, and a paid run's microVM, each of which holds only the logins made in it (the worker says so when it
 * starts). Anywhere else a worker that cannot find or start the runtime fails the command with the fix; it never
 * falls back to running it unguarded.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SANDBOX_CACHE_DIRS, SANDBOX_DEFAULT_DOMAINS, SANDBOX_DENIED_PATHS } from "../lanes/sandbox.ts";

export interface ProjectCommand {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Hosts to allow besides the defaults (a granted capability set's). */
  hosts?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number;
  /** The end of what it printed, stdout and stderr together. */
  output: string;
  durationMs: number;
  sandboxed: boolean;
}

/** How a job runs one of the project's commands; tests pass their own. */
export type ProjectExec = (command: string, at: ProjectCommand) => Promise<CommandResult>;

/** The settings document `srt --settings` reads: the same paths and hosts as the Claude lane's sandbox (lanes/sandbox.ts). */
export function srtSettings(hosts: readonly string[] = []): Record<string, unknown> {
  return {
    filesystem: { denyRead: [...SANDBOX_DENIED_PATHS], allowRead: [], allowWrite: [".", ...SANDBOX_CACHE_DIRS], denyWrite: [] },
    network: { allowedDomains: [...new Set([...SANDBOX_DEFAULT_DOMAINS, ...hosts])], deniedDomains: [], allowLocalBinding: true },
  };
}

/** The sandbox runtime's CLI script, from the installed package; undefined when it is not installed. */
export function srtCli(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
    const bin = (require(pkg) as { bin?: Record<string, string> | string }).bin;
    const rel = typeof bin === "string" ? bin : bin?.["srt"];
    return rel ? join(dirname(pkg), rel) : undefined;
  } catch {
    return undefined;
  }
}

const TAIL = 4000;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function spawn(bin: string, args: string[], at: ProjectCommand): Promise<{ code: number; output: string }> {
  return new Promise((res) => {
    const child = execFile(bin, args, { cwd: at.cwd, env: at.env, timeout: at.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, ...(at.signal ? { signal: at.signal } : {}) }, (err, stdout, stderr) => {
      const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      const why = err && !("code" in err && typeof err.code === "number") ? `\n${err.message.split("\n")[0] ?? ""}` : "";
      res({ code, output: `${String(stdout)}${String(stderr)}${why}`.slice(-TAIL).trim() });
    });
    child.stdin?.end();
  });
}

/** The `ProjectExec` a worker uses. `sandbox: false` is the operator's explicit choice. */
export const projectExec = (o: { sandbox?: boolean; cli?: string } = {}): ProjectExec => async (command, at) => {
  const t0 = Date.now();
  if (o.sandbox === false) {
    const r = await spawn("sh", ["-c", command], at);
    return { ...r, durationMs: Date.now() - t0, sandboxed: false };
  }
  const cli = o.cli ?? srtCli();
  if (!cli) return { code: 127, output: "the sandbox runtime (@anthropic-ai/sandbox-runtime) is not installed beside relay, so the project's command was not run; reinstall relay, or run the worker with --no-sandbox inside a container", durationMs: 0, sandboxed: true };
  // the settings live outside the clone, where nothing the command starts can rewrite them before the next command
  const scratch = mkdtempSync(join(tmpdir(), "relay-srt-"));
  try {
    const settings = join(scratch, "settings.json");
    writeFileSync(settings, JSON.stringify(srtSettings(at.hosts)), { mode: 0o600 });
    const r = await spawn(process.execPath, [cli, "--settings", settings, "--", "sh", "-c", command], at);
    return { ...r, durationMs: Date.now() - t0, sandboxed: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
