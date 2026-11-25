/**
 * Where Claude Code keeps what it knows about a project on one machine: `~/.claude/projects/<dir>/`, one directory
 * per working directory a session ran in. The directory's name is the absolute path with every character that is
 * not a letter or a digit turned into `-` (`/Users/me/dev/shop` is `-Users-me-dev-shop`; a worktree under
 * `.claude/worktrees/<name>` is `<repo's name>--claude-worktrees-<name>`). In it:
 *
 *   <session>.jsonl                      one transcript per session, a JSON object per line
 *   <session>/subagents/agent-<id>.jsonl the transcripts of that session's subagents
 *   memory/<name>.md                     notes with frontmatter; memory/MEMORY.md is only their index
 */
import { join } from "node:path";
import { sha256 } from "../util.ts";
import type { AdoptFs } from "./fs.ts";

/** The name Claude Code gives a working directory's project directory. The mapping loses information, so it is only ever computed forwards. */
export const claudeProjectDirName = (absPath: string): string => absPath.replace(/[^A-Za-z0-9]/g, "-");

const WORKTREE_INFIX = "--claude-worktrees-";

export interface ClaudeTranscript {
  path: string;
  bytes: number;
  subagent: boolean;
}

export interface ClaudeProjectDir {
  name: string;
  path: string;
  /** `repo`: the first checkout named, the repository itself. `worktree`: another checkout of it, the caller's or one of Claude Code's own. */
  kind: "repo" | "worktree";
  transcripts: ClaudeTranscript[];
  /** Absolute paths of `memory/*.md`, the index left out. */
  memory: string[];
}

/**
 * The project directories of a repository: one per checkout path given (the repository's root first, then any
 * other worktree of it the caller knows), plus Claude Code's own worktrees of each.
 */
export function findClaudeProjects(fs: AdoptFs, projectsRoot: string, checkouts: readonly string[]): ClaudeProjectDir[] {
  const names = checkouts.map(claudeProjectDirName);
  const found: ClaudeProjectDir[] = [];
  for (const name of fs.list(projectsRoot)) {
    const kind = name === names[0] ? "repo" : names.includes(name) || names.some((n) => name.startsWith(n + WORKTREE_INFIX)) ? "worktree" : undefined;
    const path = join(projectsRoot, name);
    if (!kind || !fs.isDir(path)) continue;
    const transcripts: ClaudeTranscript[] = [];
    const add = (file: string, subagent: boolean): void => {
      const bytes = fs.size(file);
      if (bytes !== undefined) transcripts.push({ path: file, bytes, subagent });
    };
    for (const entry of fs.list(path)) {
      if (entry.endsWith(".jsonl")) add(join(path, entry), false);
      else for (const sub of fs.list(join(path, entry, "subagents"))) if (sub.endsWith(".jsonl")) add(join(path, entry, "subagents", sub), true);
    }
    transcripts.sort((a, b) => Number(a.subagent) - Number(b.subagent) || (a.path < b.path ? -1 : 1));
    const memoryDir = join(path, "memory");
    const memory = fs.list(memoryDir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").map((n) => join(memoryDir, n));
    found.push({ name, path, kind, transcripts, memory });
  }
  return found.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "repo" ? -1 : 1));
}

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryFile {
  /** The file's name in the memory directory (`shipping-rates.md`). */
  file: string;
  /** The name a repository file gets: the file's own, lowercase letters, digits and dashes. */
  slug: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** Of the whole source file: what a later run compares to know whether the note changed. */
  hash: string;
}

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/**
 * A memory file: frontmatter of `key: value` lines with one nested map (`metadata:`, whose `type` says what the note
 * is), then the note. Older files carry `type` at the top level; both are read. Returns why not when it is not one.
 */
export function parseMemoryFile(file: string, text: string): MemoryFile | { problem: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return { problem: "no frontmatter" };
  const top: Record<string, string> = {};
  const nested: Record<string, string> = {};
  let parent = "";
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1]) {
      if (parent === "metadata") nested[kv[2]!] = unquote(kv[3]!);
    } else {
      parent = kv[2]!;
      if (kv[3]!.trim()) top[kv[2]!] = unquote(kv[3]!);
    }
  }
  const type = nested.type ?? top.type;
  if (!type) return { problem: "no type in its frontmatter" };
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) return { problem: `type '${type.slice(0, 40)}' is not one of ${MEMORY_TYPES.join(", ")}` };
  const body = m[2]!.trim();
  const base = file.replace(/\.md$/i, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!slug) return { problem: "its name has no letters or digits" };
  const description = (top.description ?? "").replace(/\s+/g, " ").trim();
  if (!body && !description) return { problem: "empty" };
  return { file, slug, name: (top.name ?? base).replace(/\s+/g, " ").trim() || base, description, type: type as MemoryType, body, hash: sha256(text) };
}
