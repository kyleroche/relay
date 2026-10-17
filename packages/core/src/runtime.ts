/**
 * Where relay's own files are at run time. relay runs from two layouts:
 *
 *   checkout  packages/core/src, packages/cli/src/main.ts (run through the repo's tsx), packages/cli/hooks/*.mjs,
 *             packages/mcp/bin/relay-mcp.mjs, packages/cli/templates, packages/core/src/db/migrations
 *   package   the published `@kyleroche/relay`: dist/relay.js bundles core, mcp and the CLI; beside it sit
 *             dist/hooks/*.mjs, dist/relay-mcp.js, dist/migrations/*.sql, dist/container/ (the worker image's
 *             Dockerfile and entry script), and templates/ at the package root
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
  migrationsDir: string;
  /** The worker image's build context: Dockerfile and relay-entry (`relay work --isolation container`). */
  containerDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));

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
    migrationsDir: join(dist, "migrations"),
    containerDir: join(dist, "container"),
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
    migrationsDir: join(root, "packages", "core", "src", "db", "migrations"),
    containerDir: join(root, "packages", "cli", "container"),
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
