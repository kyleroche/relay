/**
 * Hook installers share one shape: `plan(ctx)` computes the full new content of every file the CLI's config needs
 * (read, merge, render) without writing; `applyPlan` writes it. Running plan twice yields `unchanged` for every
 * file, so `relay setup` is idempotent and can always print what it would do before it does it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { runtimePaths } from "../runtime.ts";

export type CliName = "claude" | "codex" | "grok";
export const CLI_NAMES: readonly CliName[] = ["claude", "codex", "grok"];

export interface HookContext {
  /** Where the CLIs keep their config (`~/.claude`, `~/.codex`, `~/.grok`). Default RELAY_USER_HOME, else the OS home. */
  userHome: string;
  /** relay's own home (`~/.harness`, or RELAY_HOME) for the brief cache and capture logs. */
  relayHome: string;
  /** Absolute path of the relay checkout or installed package; hook scripts and the MCP entry are referenced from here (see `runtimePaths`). */
  repoRoot: string;
  /** Node binary used to run hook scripts and the MCP server (absolute, so hooks do not depend on PATH). */
  node: string;
}

export function defaultHookContext(repoRoot: string, overrides: Partial<HookContext> = {}): HookContext {
  return {
    userHome: process.env.RELAY_USER_HOME ?? homedir(),
    relayHome: process.env.RELAY_HOME ?? join(homedir(), ".harness"),
    repoRoot: runtimePaths(repoRoot).root,
    node: process.execPath,
    ...overrides,
  };
}

export interface PlannedFile {
  path: string;
  /** `delete` removes the file (the remembered status line once nothing refers to it); its content is "". */
  action: "create" | "update" | "unchanged" | "delete";
  content: string;
}

export interface InstallPlan {
  cli: CliName;
  detected: boolean;
  files: PlannedFile[];
  /** Human-readable remarks: commands to run by hand, unsupported events, and the like. Never credentials. */
  notes: string[];
}

export interface PlanOptions {
  /** Claude Code only: install relay's status line, which saves the plan meters Claude Code reports (default true). */
  statusline?: boolean;
}

export interface Installer {
  cli: CliName;
  detect(ctx: HookContext): boolean;
  plan(ctx: HookContext, opts?: PlanOptions): InstallPlan;
  /** Plan that removes relay's entries. */
  planRemove(ctx: HookContext): InstallPlan;
}

export function planFile(path: string, content: string): PlannedFile {
  if (!existsSync(path)) return { path, action: "create", content };
  const before = readFileSync(path, "utf8");
  return { path, action: before === content ? "unchanged" : "update", content };
}

/** A removal, planned only when the file exists (so a re-run shows nothing to do). */
export function planDelete(path: string): PlannedFile[] {
  return existsSync(path) ? [{ path, action: "delete", content: "" }] : [];
}

export function applyPlan(plan: InstallPlan): string[] {
  const written: string[] = [];
  for (const f of plan.files) {
    if (f.action === "unchanged") continue;
    if (f.action === "delete") {
      rmSync(f.path, { force: true });
      written.push(f.path);
      continue;
    }
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    written.push(f.path);
  }
  return written;
}

export function binOnPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      if (statSync(join(dir, bin)).isFile()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  const j = JSON.parse(raw) as unknown;
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${path} is not a JSON object`);
  return j as Record<string, unknown>;
}

export const toJson = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

/** Paths of the pieces hooks point at, all absolute: packages/cli/hooks and packages/mcp/bin in a checkout, dist/ in the package. */
export function hookPaths(ctx: HookContext) {
  const r = runtimePaths(ctx.repoRoot);
  return { hooksDir: r.hooksDir, sessionStart: r.sessionStart, userPrompt: r.userPrompt, sessionEnd: r.sessionEnd, statusLine: r.statusLine, mcpBin: r.mcpEntry };
}

const q = (s: string): string => (/[\s"'$`\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s);

/** A shell command line for a hook script: `<node> <script> --cli <name>`. */
export function hookCommand(ctx: HookContext, script: string, cli: CliName): string {
  return `${q(ctx.node)} ${q(script)} --cli ${cli}`;
}

/** The status-line command: `<node> <statusline.mjs>`, no arguments (Claude Code passes everything on stdin). */
export function statusLineCommand(ctx: HookContext): string {
  return `${q(ctx.node)} ${q(hookPaths(ctx).statusLine)}`;
}

/** Where `relay setup` remembers the status line it replaced, so statusline.mjs can run it and pass its output through. */
export const statusLinePrevPath = (ctx: Pick<HookContext, "relayHome">): string => join(ctx.relayHome, "statusline.prev.json");

/** True for a hook command relay installed, in either layout, so installers can find and replace their own entries. */
export const isRelayHookCommand = (command: string): boolean => /[\\/](?:packages[\\/]cli[\\/]hooks|dist[\\/]hooks)[\\/](?:session-start|user-prompt|session-end)\.mjs(?:\s|"|$)/.test(command);

/** True for the status-line command relay installed, in either layout. */
export const isRelayStatusLineCommand = (command: string): boolean => /[\\/](?:packages[\\/]cli[\\/]hooks|dist[\\/]hooks)[\\/]statusline\.mjs(?:\s|"|$)/.test(command);
