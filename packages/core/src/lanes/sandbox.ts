/**
 * The OS sandbox for the Claude lane's Bash: Claude Code's built-in sandbox (Seatbelt on macOS, bubblewrap + socat on
 * Linux), switched on per run through `--settings '<json>'` so no file on the machine and no repository setting can
 * loosen it (docs/SECURITY.md, "Workers"). One builder for the worker (`job.ts`) and for `scripts/runner/run-lane.sh`
 * (`relay lane settings`), so the two paths cannot drift.
 *
 * What it does: every Bash command and every child process (git, pnpm, a repository's own scripts) may write only
 * inside the clone and the package caches below, may not read the credential paths below, and may reach only the
 * hosts on the allowlist through Claude Code's local proxy. The sandbox does not wrap the Read/Edit/Write tools, so
 * the same paths are refused again with `permissions.deny` rules, and `blockReadsOutsideWorkingDirectories` keeps the
 * Read tool inside the clone. The Claude Code process itself (the model call) is not sandboxed, which is what lets
 * the login and the API still work.
 */

/** Hosts a code run may reach without the operator adding any: package registries and GitHub's download hosts. */
export const SANDBOX_DEFAULT_DOMAINS = ["registry.npmjs.org", "registry.yarnpkg.com", "github.com", "objects.githubusercontent.com", "codeload.github.com", "fonts.googleapis.com", "fonts.gstatic.com", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "proxy.golang.org"] as const;

/**
 * Paths no sandboxed process and no Read/Edit tool call may touch: relay's own secrets and database, every vendor CLI's login and
 * config, SSH and cloud credentials, gh, netrc, npmrc (registry tokens) and the global git config (credential
 * helpers, URL rewrites). `~` is home-relative in Claude Code settings.
 */
export const SANDBOX_DENIED_DIRS = ["~/.harness/relay.pglite", "~/.claude", "~/.codex", "~/.grok", "~/.fx", "~/.ssh", "~/.aws", "~/.config/gh"] as const;
/** relay's own home is NOT denied wholesale: the worker clones into `~/.harness/work/<repo>`, which the lane must read. Its secrets are named one by one. */
export const SANDBOX_DENIED_FILES = ["~/.harness/credentials.json", "~/.harness/config.json", "~/.harness/work.log", "~/.claude.json", "~/.netrc", "~/.npmrc", "~/.gitconfig"] as const;
export const SANDBOX_DENIED_PATHS = [...SANDBOX_DENIED_DIRS, ...SANDBOX_DENIED_FILES] as const;

/**
 * Where `pnpm install` and `npm` keep their stores and caches on macOS and Linux. Writes outside the clone are denied
 * by default; without these an install inside the sandbox cannot populate the store.
 */
export const SANDBOX_CACHE_DIRS = ["~/Library/pnpm", "~/Library/Caches/pnpm", "~/.local/share/pnpm", "~/.cache/pnpm", "~/.npm"] as const;

/** The `sandbox` and `permissions` keys of a Claude Code settings document, typed so the JSON is never hand-written. */
export interface ClaudeSandboxSettings {
  sandbox: {
    enabled: true;
    autoAllowBashIfSandboxed: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    excludedCommands: string[];
    network: {
      strictAllowlist: true;
      allowedDomains: string[];
      deniedDomains: string[];
      allowLocalBinding: boolean;
    };
    filesystem: {
      allowWrite: string[];
      denyRead: string[];
    };
    credentials: {
      files: Array<{ path: string; mode: "deny" }>;
    };
  };
  permissions: {
    blockReadsOutsideWorkingDirectories: true;
    deny: string[];
  };
}

export interface SandboxOptions {
  /** Hosts to allow in addition to `SANDBOX_DEFAULT_DOMAINS` (the worker reads `RELAY_LANE_ALLOWED_DOMAINS`). */
  allowedDomains?: string[];
  /** Directories a sandboxed process may write besides the clone and the package caches. */
  allowWrite?: string[];
  /** Let sandboxed processes bind localhost ports (a test that starts a dev server). Default true. */
  allowLocalBinding?: boolean;
}

const uniq = (xs: Iterable<string>): string[] => [...new Set([...xs].map((s) => s.trim()).filter(Boolean))];

/** `RELAY_LANE_ALLOWED_DOMAINS=a.example,b.example` → ["a.example", "b.example"]. */
export const parseDomainList = (s: string | undefined): string[] => uniq((s ?? "").split(","));

/** The deny rule for a path: a file by name, a directory with everything under it. */
const denyRule = (tool: "Read" | "Edit", path: string): string => `${tool}(${(SANDBOX_DENIED_FILES as readonly string[]).includes(path) ? path : `${path}/**`})`;

export function claudeSandboxSettings(opts: SandboxOptions = {}): ClaudeSandboxSettings {
  const denied = [...SANDBOX_DENIED_PATHS];
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      network: {
        strictAllowlist: true,
        allowedDomains: uniq([...SANDBOX_DEFAULT_DOMAINS, ...(opts.allowedDomains ?? [])]),
        deniedDomains: [],
        allowLocalBinding: opts.allowLocalBinding ?? true,
      },
      filesystem: {
        allowWrite: uniq([...SANDBOX_CACHE_DIRS, ...(opts.allowWrite ?? [])]),
        denyRead: denied,
      },
      credentials: {
        files: denied.map((path) => ({ path, mode: "deny" as const })),
      },
    },
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      deny: [...denied.map((p) => denyRule("Read", p)), ...denied.map((p) => denyRule("Edit", p))],
    },
  };
}

/** The document `--settings` receives, compact (one argv entry). */
export const claudeSandboxSettingsJson = (opts: SandboxOptions = {}): string => JSON.stringify(claudeSandboxSettings(opts));

/** The prefix `runClaude` puts on `error` when Claude Code refused to start because the sandbox could not be set up. */
export const SANDBOX_UNAVAILABLE = "sandbox unavailable";

/**
 * Does this stderr/result text say the sandbox could not be set up? `failIfUnavailable` makes Claude Code exit
 * instead of running unsandboxed; the exact wording is not documented, so this matches "sandbox" next to any of the
 * words such a message would carry (unavailable, not supported, bubblewrap/bwrap, socat).
 */
export function looksLikeSandboxUnavailable(text: string): boolean {
  const t = text.toLowerCase();
  return /sandbox/.test(t) && /(unavailable|not available|not supported|unsupported|could not|cannot|can't|failed to|missing|not found|not installed|bubblewrap|bwrap|socat|seatbelt)/.test(t);
}

/**
 * The Linux prerequisites and the operator-facing fix, for `relay doctor` and the job summary. On macOS Seatbelt is
 * built in. Returns undefined when nothing is missing.
 */
export function sandboxPrerequisites(platform: NodeJS.Platform, onPath: (bin: string) => boolean): { ok: boolean; detail: string } {
  if (platform === "darwin") return { ok: true, detail: "Seatbelt, built into macOS; the Claude lane's Bash runs inside it" };
  if (platform === "linux") {
    const missing = ["bwrap", "socat"].filter((b) => !onPath(b));
    if (!missing.length) return { ok: true, detail: "bubblewrap and socat on PATH; the Claude lane's Bash runs inside bubblewrap" };
    return { ok: false, detail: `${missing.join(" and ")} missing; install with: sudo apt install bubblewrap socat  (or: sudo dnf install bubblewrap socat). Claude jobs fail until then (relay work never runs them unsandboxed)` };
  }
  return { ok: false, detail: `no OS sandbox for Claude Code on ${platform}; Claude jobs fail here (relay work never runs them unsandboxed)` };
}
