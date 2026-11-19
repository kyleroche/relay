/**
 * Where relay's own files are at run time. relay runs from two layouts:
 *
 *   checkout  packages/core/src, packages/cli/src/main.ts (run through the repo's tsx), packages/cli/hooks/*.mjs,
 *             packages/mcp/bin/relay-mcp.mjs, packages/cli/templates, packages/core/src/db/migrations
 *   package   the published `@kyleroche/relay`: dist/relay.js bundles core, mcp and the CLI; beside it sit
 *             dist/hooks/*.mjs, dist/relay-mcp.js, dist/migrations/*.sql, dist/container/ (the worker image's
 *             Dockerfile and entry script), dist/python/ (the Griptape Nodes shim), and templates/ at the package root
 *
 * Anything that records a path to a relay file (the hook installers, the template copier, the migration loader)
 * asks here instead of counting `..` from its own location, because in the bundle every module shares one
 * `import.meta.url`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RelayLayout = "checkout" | "package";

export interface RuntimePaths {
  layout: RelayLayout;
  /** The checkout root, or the installed package's root (the directory holding its package.json). */
  root: string;
  /** Arguments after `node` that run the relay CLI: `[tsx, main.ts]` in a checkout, `[dist/relay.js]` in the package. */
  cliArgv: string[];
  hooksDir: string;
  sessionStart: string;
  userPrompt: string;
  sessionEnd: string;
  /** Claude Code's status-line command: saves the plan meters it is handed, then runs the user's own status line. */
  statusLine: string;
  /** The stdio MCP entry the CLIs' configs point at. */
  mcpEntry: string;
  /** The caller workflows `relay link` copies into a repo. */
  templatesDir: string;
  /** The steps relay ships (`steps/index.ts`): remove-yap, eval, eval-respond, cleanup. */
  stepsDir: string;
  migrationsDir: string;
  /** The worker image's build context: Dockerfile and relay-entry (`relay work --isolation container`). */
  containerDir: string;
  /** The Python scripts relay starts under other interpreters: `run_workflow.py`, the Griptape Nodes shim (`lanes/nodes.ts`). */
  pythonDir: string;
  runWorkflowScript: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Node path relay writes into files that outlive this process (the CLIs' hook commands, the MCP entry, the
 * service file). `process.execPath` is the real path, and under Homebrew that is the versioned Cellar directory
 * (`…/Cellar/node@24/24.18.0/bin/node`), which `brew upgrade` deletes: every recorded hook then points at nothing.
 * Homebrew keeps `…/opt/<formula>/bin/node` pointing at the installed version, so that is what gets recorded when it
 * exists. Any other path (a version manager's, the system's) is returned as it is: those stay where they are.
 */
export function stableNodePath(execPath: string = process.execPath, exists: (p: string) => boolean = existsSync): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/(node(?:\.exe)?)$/.exec(execPath);
  if (!m) return execPath;
  const stable = `${m[1]}/opt/${m[2]}/bin/${m[3]}`;
  return exists(stable) ? stable : execPath;
}

/**
 * Absolute paths to a `node` binary found in a file's text (a hook command, an MCP server entry, a service file)
 * that no longer exist on this machine. `runs` keeps only the ones that run a matching file: the pattern has to
 * appear after the path and before the next `node` path (or within 400 characters), which is where a command's
 * script or an entry's `args` are written, so a neighbouring entry of the user's own is left alone. `relay doctor`
 * prints what this returns with the fix.
 */
export function missingNodePaths(text: string, opts: { exists?: (p: string) => boolean; runs?: RegExp } = {}): string[] {
  const exists = opts.exists ?? existsSync;
  const matches = [...text.matchAll(/(\/[^\s"'<>,\\]+\/bin\/node)(?![\w.@-])/g)];
  const found = new Set<string>();
  matches.forEach((m, i) => {
    const end = (m.index ?? 0) + m[1]!.length;
    const next = matches[i + 1]?.index ?? text.length;
    if (opts.runs && !opts.runs.test(text.slice(end, Math.min(next, end + 400)))) return;
    found.add(m[1]!);
  });
  return [...found].filter((p) => !exists(p));
}

function packageAt(root: string): RuntimePaths {
  const dist = join(root, "dist");
  const hooksDir = join(dist, "hooks");
  return {
    layout: "package",
    root,
    cliArgv: [join(dist, "relay.js")],
    hooksDir,
    sessionStart: join(hooksDir, "session-start.mjs"),
    userPrompt: join(hooksDir, "user-prompt.mjs"),
    sessionEnd: join(hooksDir, "session-end.mjs"),
    statusLine: join(hooksDir, "statusline.mjs"),
    mcpEntry: join(dist, "relay-mcp.js"),
    templatesDir: join(root, "templates"),
    stepsDir: join(dist, "steps"),
    migrationsDir: join(dist, "migrations"),
    containerDir: join(dist, "container"),
    pythonDir: join(dist, "python"),
    runWorkflowScript: join(dist, "python", "run_workflow.py"),
  };
}

function checkoutAt(root: string): RuntimePaths {
  const hooksDir = join(root, "packages", "cli", "hooks");
  return {
    layout: "checkout",
    root,
    cliArgv: [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "packages", "cli", "src", "main.ts")],
    hooksDir,
    sessionStart: join(hooksDir, "session-start.mjs"),
    userPrompt: join(hooksDir, "user-prompt.mjs"),
    sessionEnd: join(hooksDir, "session-end.mjs"),
    statusLine: join(hooksDir, "statusline.mjs"),
    mcpEntry: join(root, "packages", "mcp", "bin", "relay-mcp.mjs"),
    templatesDir: join(root, "packages", "cli", "templates"),
    stepsDir: join(root, "packages", "cli", "steps"),
    migrationsDir: join(root, "packages", "core", "src", "db", "migrations"),
    containerDir: join(root, "packages", "cli", "container"),
    pythonDir: join(root, "packages", "cli", "python"),
    runWorkflowScript: join(root, "packages", "cli", "python", "run_workflow.py"),
  };
}

/** Which layout a directory holds, judged by the files only one of them has. Undefined when it is neither. */
export function detectLayout(root: string): RelayLayout | undefined {
  if (existsSync(join(root, "dist", "relay.js")) && existsSync(join(root, "dist", "hooks", "session-start.mjs"))) return "package";
  if (existsSync(join(root, "packages", "cli", "hooks", "session-start.mjs"))) return "checkout";
  return undefined;
}

/** This module is packages/core/src/runtime.ts in a checkout and part of dist/relay.js in the package. */
function selfRoot(): RuntimePaths {
  const pkg = dirname(here);
  if (detectLayout(pkg) === "package") return packageAt(pkg);
  return checkoutAt(resolve(here, "..", "..", ".."));
}

/**
 * Paths for the relay that is running, or for the relay at `root` when given. A root holding one of the two
 * layouts is described as such; a root that does not exist is taken at face value as a checkout (callers planning
 * against a hypothetical install); an existing directory that is neither (a bundled module counting `..` from
 * dist/) falls back to self-detection.
 */
export function runtimePaths(root?: string): RuntimePaths {
  if (root) {
    const layout = detectLayout(root);
    if (layout === "package") return packageAt(root);
    if (layout === "checkout" || !existsSync(root)) return checkoutAt(root);
  }
  return selfRoot();
}
