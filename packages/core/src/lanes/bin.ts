/**
 * Where a vendor CLI is on this machine, the same answer for the lane adapters and `relay doctor`'s probes:
 * `RELAY_<NAME>_BIN` when set, else the native installer's `~/.local/bin/<name>` when that file exists (Claude Code's
 * and fx's installers on a Mac), else the first match on PATH (an npm global under /usr/local/bin, as in the worker
 * container, or a package manager's), else the bare name for the OS to resolve. 2026-11-03: the Claude and fx lanes
 * looked only under ~/.local/bin, so the container worker, where both are npm globals, failed every job with
 * "exited 1" while doctor, which searches PATH, said the logins were fine.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "../github/client.ts";

export function cliBin(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`RELAY_${name.toUpperCase()}_BIN`];
  if (override) return override;
  const local = join(homedir(), ".local", "bin", name);
  if (existsSync(local)) return local;
  return findOnPath(name) ?? name;
}
