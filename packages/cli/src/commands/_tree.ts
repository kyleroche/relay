/**
 * A repository's default branch as something to read from and propose to, without checking it out. `relay link`
 * reads the files it would change from the default branch as origin has it, builds its changes as one commit on top
 * of that, and pushes the commit to a branch for a pull request. The working tree, the index and the current branch
 * are never written: the commit is made in a temporary index (`GIT_INDEX_FILE`) with `git commit-tree`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { diskAdoptFs, type AdoptFs } from "@relay/core";

function git(root: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 60_000,
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  }
}

export interface RemoteBase {
  /** The default branch of origin. */
  branch: string;
  /** Its tip, present in this clone's object store. */
  sha: string;
}

/** Origin's default branch and its tip, fetched if this clone does not have it. Throws with git's own words when origin cannot be reached or is empty. */
export function remoteBase(root: string): RemoteBase {
  const out = git(root, ["ls-remote", "--symref", "origin", "HEAD"]);
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1];
  const sha = /^([0-9a-f]{40,64})\s+HEAD$/m.exec(out)?.[1];
  if (!branch || !sha) throw new Error("origin has no default branch yet (an empty repository?)");
  ensureObject(root, sha, `refs/heads/${branch}`);
  return { branch, sha };
}

function hasObject(root: string, sha: string): boolean {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function ensureObject(root: string, sha: string, ref: string): void {
  if (hasObject(root, sha)) return;
  git(root, ["fetch", "--quiet", "--no-write-fetch-head", "origin", ref], { timeoutMs: 5 * 60_000 });
  if (!hasObject(root, sha)) throw new Error(`fetched ${ref} from origin and still do not have ${sha.slice(0, 8)}`);
}

interface Entry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number;
}

/** A commit's files, read from git. Paths are from the repository's root, with `/`. */
export interface TreeReader {
  read(path: string): string | undefined;
  /** The names in a directory, sorted; empty when it is not one. */
  list(dir: string): string[];
  isDir(path: string): boolean;
  size(path: string): number | undefined;
  mode(path: string): string | undefined;
}

const clean = (path: string): string => path.replace(/^\.?\/+/, "").replace(/\/+$/, "");

export function treeReader(root: string, ref: string): TreeReader {
  const entries = new Map<string, Entry>();
  const children = new Map<string, string[]>();
  for (const row of git(root, ["ls-tree", "-r", "-t", "-z", "--long", ref]).split("\0")) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha, size] = row.slice(0, tab).split(/\s+/);
    const path = row.slice(tab + 1);
    entries.set(path, { mode: mode!, type: type as Entry["type"], sha: sha!, size: size === "-" ? 0 : Number(size) });
    const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
    (children.get(dir) ?? children.set(dir, []).get(dir)!).push(posix.basename(path));
  }
  const blob = (path: string): Entry | undefined => {
    const e = entries.get(clean(path));
    return e?.type === "blob" ? e : undefined;
  };
  return {
    read: (path) => {
      const e = blob(path);
      return e ? git(root, ["cat-file", "blob", e.sha]) : undefined;
    },
    list: (dir) => [...(children.get(clean(dir)) ?? [])].sort(),
    isDir: (path) => clean(path) === "" || entries.get(clean(path))?.type === "tree",
    size: (path) => blob(path)?.size,
    mode: (path) => blob(path)?.mode,
  };
}

/** The working tree read the same way, for a repository with no origin to propose to. */
export function diskReader(root: string): TreeReader {
  const fs = diskAdoptFs();
  const at = (path: string): string => join(root, clean(path));
  return { read: (p) => fs.read(at(p)), list: (d) => fs.list(at(d)), isDir: (p) => fs.isDir(at(p)), size: (p) => fs.size(at(p)), mode: () => undefined };
}

/**
 * What adoption reads through when the repository's files are a commit and not the working tree: paths under `root`
 * come from `tree`, everything else (Claude Code's directories under the home) from the disk.
 */
export function overlayAdoptFs(root: string, tree: TreeReader, disk: AdoptFs = diskAdoptFs()): AdoptFs {
  const base = root.replace(/\/+$/, "");
  const rel = (path: string): string | undefined => (path === base ? "" : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined);
  const pick = <T>(path: string, inTree: (rel: string) => T, onDisk: () => T): T => {
    const r = rel(path);
    return r === undefined ? onDisk() : inTree(r);
  };
  return {
    list: (dir) => pick(dir, (r) => tree.list(r), () => disk.list(dir)),
    read: (path) => pick(path, (r) => tree.read(r), () => disk.read(path)),
    size: (path) => pick(path, (r) => tree.size(r), () => disk.size(path)),
    isDir: (path) => pick(path, (r) => tree.isDir(r), () => disk.isDir(path)),
    chunks: (path) =>
      pick<AsyncIterable<Uint8Array>>(
        path,
        (r) =>
          (async function* () {
            const text = tree.read(r);
            if (text !== undefined) yield Buffer.from(text);
          })(),
        () => disk.chunks(path),
      ),
  };
}

/** One file of a proposal: its whole new text, or `remove`. */
export interface TreeChange {
  path: string;
  content?: string;
  remove?: boolean;
}

export interface Proposal {
  /** The new commit; equal to `base` when the changes change nothing. */
  sha: string;
  base: string;
  /** The paths that differ from `base`. */
  changed: string[];
}

/** `changes` as one commit on top of `base`, made without touching the checkout. */
export function commitOnBase(root: string, base: string, changes: readonly TreeChange[], message: string): Proposal {
  const scratch = mkdtempSync(join(tmpdir(), "relay-link-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(root, ["read-tree", base], { env });
    const modes = treeReader(root, base);
    for (const c of changes) {
      if (c.remove || c.content === undefined) {
        git(root, ["update-index", "--force-remove", "--", c.path], { env });
        continue;
      }
      const blob = git(root, ["hash-object", "-w", "--stdin"], { input: c.content }).trim();
      git(root, ["update-index", "--add", "--cacheinfo", `${modes.mode(c.path) ?? "100644"},${blob},${c.path}`], { env });
    }
    const tree = git(root, ["write-tree"], { env }).trim();
    if (tree === git(root, ["rev-parse", `${base}^{tree}`]).trim()) return { sha: base, base, changed: [] };
    const changed = git(root, ["diff-tree", "-r", "--name-only", "--no-renames", base, tree]).split("\n").filter(Boolean);
    return { sha: git(root, ["commit-tree", tree, "-p", base, "-m", message]).trim(), base, changed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The tip of a branch on origin, or undefined when origin has no such branch. */
export function remoteBranch(root: string, branch: string): string | undefined {
  return /^([0-9a-f]{40,64})\s/m.exec(git(root, ["ls-remote", "origin", `refs/heads/${branch}`]))?.[1];
}

/**
 * Does the branch on origin already hold these changes? True when every file to write is there with the same text
 * and every file to remove is gone, whatever else moved under it: a second run then leaves the branch, and whatever
 * a reviewer pushed to it, alone.
 */
export function branchHolds(root: string, branch: string, tip: string, changes: readonly TreeChange[]): boolean {
  try {
    ensureObject(root, tip, `refs/heads/${branch}`);
  } catch {
    return false;
  }
  const there = treeReader(root, tip);
  return changes.every((c) => (c.remove || c.content === undefined ? there.read(c.path) === undefined && !there.isDir(c.path) : there.read(c.path) === c.content));
}

/**
 * Put `sha` on origin as `branch`. A branch that is already there is replaced only if it is still at `seen`, the tip
 * this run looked at; without `seen` the branch must not exist.
 */
export function pushProposal(root: string, sha: string, branch: string, seen: string | undefined): void {
  git(root, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${seen ?? ""}`, "origin", `${sha}:refs/heads/${branch}`], { timeoutMs: 5 * 60_000 });
}
