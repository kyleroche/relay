/** Shared helpers for the relay CLI commands: logging, repo discovery, project resolution, harness opening. */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, openHarness, readRulesState, type OpenHarness } from "@relay/core";

export const log = (m: string): void => console.error(`[relay] ${m}`);

/** Absolute path of the relay checkout (this file lives at packages/cli/src/commands/). */
export const RELAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

export function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
}

export const gitRoot = (cwd: string): string | undefined => git(cwd, ["rev-parse", "--show-toplevel"]);

/** `owner/name` from the origin remote (https, ssh, or git protocol forms). */
export function parseRepo(url: string): string | undefined {
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export const gitRemoteRepo = (cwd: string): string | undefined => {
  const url = git(cwd, ["remote", "get-url", "origin"]);
  return url ? parseRepo(url) : undefined;
};

export interface ProjectRef {
  /** Repo root (git toplevel, or the cwd when not a git repo). */
  root: string;
  /** Project slug: --project, else .relay/rules.json, else the remote repo's name. */
  slug?: string;
  repo?: string;
  /** True when .relay/rules.json names a project, i.e. `relay link` ran here. */
  linked: boolean;
}

/** Walk up from cwd to the nearest directory holding .relay/rules.json (cheap; no git call). */
export function findLinkedRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".relay", "rules.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function resolveProject(opts: { cwd?: string; project?: string }): ProjectRef {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const linkedRoot = findLinkedRoot(cwd);
  const root = linkedRoot ?? gitRoot(cwd) ?? cwd;
  const state = linkedRoot ? readRulesState(linkedRoot) : undefined;
  const repo = state?.repo ?? gitRemoteRepo(root);
  const slug = opts.project ?? state?.project ?? (repo ? repo.split("/")[1] : undefined);
  const out: ProjectRef = { root, linked: !!state?.project };
  if (slug) out.slug = slug;
  if (repo) out.repo = repo;
  return out;
}

/** Open the harness with the schema applied. */
export async function openReady(): Promise<OpenHarness> {
  const h = await openHarness();
  await migrate(h.db);
  return h;
}

export const humanActor = (): string => `human:${process.env.RELAY_ACTOR ?? process.env.USER ?? "local"}`;

/** In hook mode nothing may break the session: swallow errors, print nothing, exit 0. */
export async function hookSafe(hook: boolean, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!hook) throw e;
    log(`hook: ${e instanceof Error ? e.message : String(e)}`);
  }
}
