/**
 * The Claude lane's argv and its OS sandbox (docs/SECURITY.md, "Workers"): the settings document is built from a typed
 * object, reaches `claude` as one `--settings` argument on code runs only, and a machine that cannot sandbox fails the
 * run with a recognisable error instead of running Bash unsandboxed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, runClaude, sandboxFor } from "../src/lanes/claude.ts";
import {
  claudeSandboxSettings,
  claudeSandboxSettingsJson,
  looksLikeSandboxUnavailable,
  parseDomainList,
  SANDBOX_CACHE_DIRS,
  SANDBOX_DEFAULT_DOMAINS,
  SANDBOX_DENIED_DIRS,
  SANDBOX_DENIED_FILES,
  SANDBOX_DENIED_PATHS,
  SANDBOX_UNAVAILABLE,
  sandboxPrerequisites,
} from "../src/lanes/sandbox.ts";
import type { LaneRequest } from "../src/lanes/types.ts";
import { CODE_DISALLOWED_TOOLS, CODE_TOOLS } from "../src/work/job.ts";

const codeReq: LaneRequest = { lane: "code", prompt: "# relay brief\n\nAdd hello.", cwd: "/work/acme_demo_1", env: { PATH: "/usr/bin", HOME: "/Users/w" } };

describe("claudeSandboxSettings", () => {
  it("locks the sandbox on, refuses to run unsandboxed, and allows only the default hosts", () => {
    const s = claudeSandboxSettings();
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.failIfUnavailable).toBe(true);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(s.sandbox.excludedCommands).toEqual([]);
    expect(s.sandbox.network.strictAllowlist).toBe(true);
    expect(s.sandbox.network.allowedDomains).toEqual([...SANDBOX_DEFAULT_DOMAINS]);
    expect(s.sandbox.network.deniedDomains).toEqual([]);
    expect(s.sandbox.network.allowLocalBinding).toBe(true);
  });

  it("denies every credential path three ways: sandbox denyRead, credentials.files, and Read/Edit permission rules", () => {
    const s = claudeSandboxSettings();
    for (const p of ["~/.harness", "~/.claude", "~/.claude.json", "~/.codex", "~/.grok", "~/.fx", "~/.ssh", "~/.aws", "~/.config/gh", "~/.netrc", "~/.npmrc", "~/.gitconfig"]) expect(SANDBOX_DENIED_PATHS).toContain(p);
    expect(s.sandbox.filesystem.denyRead).toEqual([...SANDBOX_DENIED_PATHS]);
    expect(s.sandbox.credentials.files).toEqual(SANDBOX_DENIED_PATHS.map((path) => ({ path, mode: "deny" })));
    for (const d of SANDBOX_DENIED_DIRS) {
      expect(s.permissions.deny).toContain(`Read(${d}/**)`);
      expect(s.permissions.deny).toContain(`Edit(${d}/**)`);
    }
    for (const f of SANDBOX_DENIED_FILES) {
      expect(s.permissions.deny).toContain(`Read(${f})`);
      expect(s.permissions.deny).toContain(`Edit(${f})`);
    }
    expect(s.permissions.deny).toHaveLength(SANDBOX_DENIED_PATHS.length * 2);
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it("lets pnpm and npm write their stores and caches, and nothing else outside the clone", () => {
    expect(claudeSandboxSettings().sandbox.filesystem.allowWrite).toEqual([...SANDBOX_CACHE_DIRS]);
    expect(claudeSandboxSettings({ allowWrite: ["~/.cache/relay-test"] }).sandbox.filesystem.allowWrite).toContain("~/.cache/relay-test");
  });

  it("adds the caller's hosts after the defaults, trimmed and deduplicated", () => {
    const s = claudeSandboxSettings({ allowedDomains: [" api.example.com", "github.com", "api.example.com", ""] });
    expect(s.sandbox.network.allowedDomains).toEqual([...SANDBOX_DEFAULT_DOMAINS, "api.example.com"]);
    expect(parseDomainList(" a.example, b.example,,a.example ")).toEqual(["a.example", "b.example"]);
    expect(parseDomainList(undefined)).toEqual([]);
  });

  it("serialises to one line that parses back to the same object", () => {
    const json = claudeSandboxSettingsJson();
    expect(json).not.toContain("\n");
    expect(JSON.parse(json)).toEqual(claudeSandboxSettings());
  });
});

describe("claudeArgs", () => {
  it("a code run carries the allowlist, the refusal list, no setting sources, and the sandbox as --settings", () => {
    const args = claudeArgs(codeReq, { model: "opus", allowedTools: CODE_TOOLS, disallowedTools: CODE_DISALLOWED_TOOLS, maxTurns: 40 });
    expect(args).toMatchSnapshot();
    const i = args.indexOf("--settings");
    expect(i).toBeGreaterThan(0);
    expect(JSON.parse(args[i + 1]!)).toEqual(claudeSandboxSettings());
    expect(args.indexOf("--setting-sources")).toBeLessThan(i); // our document is the only settings source
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--disallowedTools");
    expect(args.slice(-2)).toEqual(["--", codeReq.prompt]);
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
  });

  it("RELAY_LANE_ALLOWED_DOMAINS in the job's environment widens the network allowlist", () => {
    const req = { ...codeReq, env: { ...codeReq.env, RELAY_LANE_ALLOWED_DOMAINS: "api.example.com, cdn.example.com" } };
    expect(sandboxFor(req, { model: "opus" })).toEqual({ allowedDomains: ["api.example.com", "cdn.example.com"] });
    const args = claudeArgs(req, { model: "opus", sandbox: { allowedDomains: ["first.example"] } });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as ReturnType<typeof claudeSandboxSettings>;
    expect(settings.sandbox.network.allowedDomains).toEqual([...SANDBOX_DEFAULT_DOMAINS, "first.example", "api.example.com", "cdn.example.com"]);
  });

  it("is on for code requests only, unless the caller says otherwise", () => {
    const utility: LaneRequest = { lane: "digest", prompt: "p", cwd: "/x", env: {} };
    const probe: LaneRequest = { lane: "probe", prompt: "p", cwd: "/x", readOnly: true, env: {} };
    expect(sandboxFor(codeReq, { model: "opus" })).toEqual({});
    expect(sandboxFor(codeReq, { model: "opus", sandbox: false })).toBeUndefined();
    expect(sandboxFor(utility, { model: "sonnet", tools: [] })).toBeUndefined();
    expect(sandboxFor(probe, { model: "sonnet" })).toBeUndefined();
    expect(sandboxFor(probe, { model: "sonnet", sandbox: true })).toEqual({});
    expect(claudeArgs(utility, { model: "sonnet", tools: [] })).not.toContain("--settings");
    expect(claudeArgs(probe, { model: "sonnet" })).not.toContain("--settings");
    expect(claudeArgs(codeReq, { model: "opus", sandbox: false })).not.toContain("--settings");
    expect(claudeArgs(probe, { model: "sonnet", sandbox: true })).toContain("--settings");
  });
});

describe("the sandbox on a machine that cannot provide it", () => {
  let bins: string;
  const fakeBin = (name: string, body: string): string => {
    const p = join(bins, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  beforeAll(() => {
    delete process.env.RELAY_FAKE_LANES;
    bins = mkdtempSync(join(tmpdir(), "relay-fake-claude-"));
  });
  afterAll(() => rmSync(bins, { recursive: true, force: true }));

  it("looksLikeSandboxUnavailable recognises the refusal and not an ordinary failure", () => {
    expect(looksLikeSandboxUnavailable("Error: Sandbox is enabled with failIfUnavailable but the sandbox is unavailable on this system")).toBe(true);
    expect(looksLikeSandboxUnavailable("sandbox: bubblewrap (bwrap) not found; install bubblewrap and socat")).toBe(true);
    expect(looksLikeSandboxUnavailable("Sandboxing is not supported on this platform")).toBe(true);
    expect(looksLikeSandboxUnavailable("Error: Not logged in. Run /login")).toBe(false);
    expect(looksLikeSandboxUnavailable("Edited sandbox.ts; tests pass")).toBe(false);
  });

  it("runClaude marks the error SANDBOX_UNAVAILABLE when claude exits for that reason, and leaves other errors alone", async () => {
    const refusing = fakeBin("claude-refuses", 'echo "Error: sandbox unavailable: bubblewrap (bwrap) is not installed" >&2; exit 1');
    const r = await runClaude({ ...codeReq, cwd: bins, timeoutMs: 20_000 }, { model: "opus", bin: refusing });
    expect(r.ok).toBe(false);
    expect(r.error?.startsWith(`${SANDBOX_UNAVAILABLE}: `)).toBe(true);
    expect(r.error).toContain("bubblewrap");

    const broken = fakeBin("claude-broken", 'echo "Error: Not logged in" >&2; exit 1');
    const other = await runClaude({ ...codeReq, cwd: bins, timeoutMs: 20_000 }, { model: "opus", bin: broken });
    expect(other.ok).toBe(false);
    expect(other.error?.startsWith(SANDBOX_UNAVAILABLE)).toBe(false);

    // an unsandboxed run that happens to mention the sandbox is not a sandbox refusal
    const unsandboxed = await runClaude({ ...codeReq, cwd: bins, timeoutMs: 20_000 }, { model: "opus", bin: refusing, sandbox: false });
    expect(unsandboxed.error?.startsWith(SANDBOX_UNAVAILABLE)).toBe(false);
  });

  it("the --settings document reaches the claude process as one argument", async () => {
    // prints its argv as the JSON result, one line per argument, so the test sees exactly what claude would
    const script = join(bins, "echo-argv.mjs");
    writeFileSync(script, 'console.log(JSON.stringify({ type: "result", is_error: false, result: process.argv.slice(2).join("\\n") }));\n');
    const echo = fakeBin("claude-echo", `exec "${process.execPath}" "${script}" "$@"`);
    const r = await runClaude({ ...codeReq, cwd: bins, timeoutMs: 20_000 }, { model: "opus", bin: echo });
    expect(r.ok).toBe(true);
    const argv = r.text.split("\n");
    const i = argv.indexOf("--settings");
    expect(i).toBeGreaterThan(0);
    expect(JSON.parse(argv[i + 1]!)).toEqual(claudeSandboxSettings());
  });
});

describe("sandboxPrerequisites", () => {
  it("macOS is always ready; Linux needs bwrap and socat; anything else is a warning", () => {
    expect(sandboxPrerequisites("darwin", () => false).ok).toBe(true);
    expect(sandboxPrerequisites("linux", () => true).ok).toBe(true);
    const missing = sandboxPrerequisites("linux", (b) => b === "socat");
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("bwrap missing");
    expect(missing.detail).toContain("apt install bubblewrap socat");
    expect(sandboxPrerequisites("linux", () => false).detail).toContain("bwrap and socat missing");
    expect(sandboxPrerequisites("win32", () => true).ok).toBe(false);
  });
});
