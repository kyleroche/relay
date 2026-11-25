/**
 * Adoption: get a project's working knowledge out of Claude Code's files on one machine and into places a worker on
 * another machine reads. A worker sees only the repository it clones, the task's thread and relay's memory, so:
 *
 *   memory notes of type project | reference   become files in the repository, `docs/context/<name>.md`, with a
 *                                              `README.md` there that lists each with one line. They are reviewed
 *                                              like any other change: by pull request.
 *   memory notes of type feedback | user       become decisions in relay's memory, scoped to the project.
 *   transcripts                                are never read by a model. They are only counted: which commands
 *                                              were run (commands.ts), which gives a first `.relay/project.json`
 *                                              (draft.ts).
 *
 * Two functions, for `relay link` and for `relay adopt` (which only prints the plan):
 *
 *   planAdoption    looks, and returns what would happen: the repository files with their contents, the decisions,
 *                   what was skipped and why, the profile draft or its difference from the profile that is there.
 *   applyAdoption   records the plan's decisions through the client, once each, and hands back the files.
 *
 * Neither writes to the repository or runs git: the files come back as `{ path, content }` and the caller decides
 * where they go. Every text passes the secret check (secrets.ts) before it is in a plan; a note that fails is
 * skipped whole and named.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { RelayClient } from "../client/types.ts";
import { relayHome } from "../hooks/cache.ts";
import { PROFILE_PATH } from "../steps/index.ts";
import { findClaudeProjects, parseMemoryFile, type ClaudeProjectDir, type MemoryFile } from "./claude.ts";
import { mineCommands, type CommandCount } from "./commands.ts";
import { draftProfile, lineDiff, type ProfileDraft } from "./draft.ts";
import { diskAdoptFs, type AdoptFs } from "./fs.ts";
import { findSecrets } from "./secrets.ts";

export * from "./fs.ts";
export * from "./claude.ts";
export * from "./commands.ts";
export * from "./draft.ts";
export * from "./secrets.ts";

export const CONTEXT_DIR = "docs/context";
export const CONTEXT_INDEX = `${CONTEXT_DIR}/README.md`;
/** `decisions.source` of a decision adoption recorded. */
export const ADOPT_SOURCE = "adopt";

/** Where Claude Code keeps its per-project directories on this machine (`RELAY_USER_HOME` moves the home, as for the hook installers). */
export const claudeProjectsRoot = (userHome: string = process.env.RELAY_USER_HOME ?? homedir()): string => join(userHome, ".claude", "projects");

/** What adoption remembers between runs, under relay's home: which note became which decision, by the note's hash. */
export interface AdoptState {
  /** project slug, then the note's file name. */
  decisions: Record<string, Record<string, { hash: string; id: number; at: string }>>;
}

export const adoptStatePath = (home: string = relayHome()): string => join(home, "cache", "adopt-state.json");

export function readAdoptState(home: string = relayHome()): AdoptState {
  const p = adoptStatePath(home);
  if (!existsSync(p)) return { decisions: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<AdoptState>;
    return { decisions: j.decisions && typeof j.decisions === "object" ? j.decisions : {} };
  } catch {
    return { decisions: {} };
  }
}

export function writeAdoptState(state: AdoptState, home: string = relayHome()): void {
  const p = adoptStatePath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

export interface AdoptFile {
  /** From the repository's root. */
  path: string;
  content: string;
  /** `write`: the repository has no such file. `update`: it has an older one that adoption wrote. */
  action: "write" | "update";
  kind: "context" | "index" | "profile";
  /** One line for the report. */
  about: string;
}

export interface AdoptDecision {
  /** The note's file name, which is also what a later run finds it by. */
  file: string;
  title: string;
  text: string;
  hash: string;
  /** `same`: this note, unchanged, is already a decision. `update`: it changed, and the new text supersedes the old decision. */
  action: "record" | "update" | "same";
  supersedes?: number;
  sourceRef: string;
}

export interface AdoptSkip {
  /** The note's file name, or the path of a repository file left alone. */
  file: string;
  why: string;
}

export interface AdoptProfile {
  draft: ProfileDraft;
  /** The draft as `.relay/project.json` would hold it; empty when nothing was found to propose. */
  json: string;
  problems: string[];
  notes: string[];
  /** The repository already has a profile: it is left alone, and `diff` is what the draft would add to it. */
  exists: boolean;
  diff: string;
}

export interface AdoptPlan {
  root: string;
  project: string | null;
  found: {
    projectsRoot: string;
    dirs: Array<{ name: string; kind: ClaudeProjectDir["kind"]; transcripts: number; transcriptBytes: number; subagentTranscripts: number; subagentBytes: number; memoryFiles: number }>;
    transcripts: number;
    transcriptBytes: number;
    memoryFiles: number;
  };
  /** The repository files to write, contents included. */
  files: AdoptFile[];
  /** Repository files that are already what adoption would write. */
  unchanged: string[];
  decisions: AdoptDecision[];
  skipped: AdoptSkip[];
  commands: { transcripts: number; lines: number; skippedLines: number; bashCalls: number; top: CommandCount[] };
  profile: AdoptProfile;
}

export interface PlanInput {
  /** The repository's root, absolute. */
  root: string;
  /** The project the decisions are for; without one they are planned and cannot be recorded. */
  project?: string | null;
  /** Other checkouts of the same repository (`git worktree list`), absolute. Claude Code's own worktrees are found without being named. */
  worktrees?: readonly string[];
  fs?: AdoptFs;
  projectsRoot?: string;
  state?: AdoptState;
  /** Read the transcripts for the commands that were run (default true). */
  transcripts?: boolean;
  /** How many of the most-run commands the plan carries for the report (default 25). */
  top?: number;
}

const MARK = /<!-- relay adopt: from Claude Code memory `([^`]+)`, sha256 ([0-9a-f]{16})\b/;
const INDEX_MARK = "<!-- relay adopt: index of this directory; rewritten when a note is added or changes -->";

const titleOf = (slug: string): string => {
  const words = slug.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The titles Claude Code's own index gives the notes: `- [Title](file.md) — hook` lines of `memory/MEMORY.md`. */
function indexTitles(text: string | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  for (const m of (text ?? "").matchAll(/^\s*[-*]\s*\[([^\]\n]+)\]\(([^)\s]+\.md)\)/gm)) titles.set(m[2]!, m[1]!.trim());
  return titles;
}

/** A note as a repository file: its title, its one-line description, the note itself, and the mark a later run knows it by. */
export function contextFile(note: MemoryFile, title: string): string {
  const head = [`# ${title}`, ...(note.description ? ["", `> ${note.description}`] : [])];
  return `${[...head, "", note.body || note.description, "", `<!-- relay adopt: from Claude Code memory \`${note.file}\`, sha256 ${note.hash.slice(0, 16)}. relay rewrites this file only when that note changes. -->`].join("\n")}\n`;
}

/** The directory's index: every note with its one line, so an agent can pick the one its task needs. */
export function contextIndex(entries: ReadonlyArray<{ file: string; title: string; description: string }>): string {
  const rows = [...entries].sort((a, b) => (a.file < b.file ? -1 : 1)).map((e) => `- [${e.title}](${e.file})${e.description ? `: ${e.description}` : ""}`);
  return `${["# Project context", "", "What the people and agents who worked on this project learned about it, one note per file. Read the ones your task touches before you start; each line below says what its file holds.", "", ...rows, "", INDEX_MARK].join("\n")}\n`;
}

/**
 * A feedback or user note as a decision: its one-line description, which is the rule, and the reason the note gives
 * for it (`**Why:** …`). A decision is read in every brief, so it is a sentence or two, not the note.
 */
export function decisionText(note: MemoryFile): string {
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
  const firstParagraph = flat(note.body.split(/\r?\n\s*\r?\n/)[0] ?? "");
  const rule = note.description || firstParagraph;
  const why = /\*\*Why:?\*\*:?\s*([\s\S]*?)(?:\r?\n\s*\r?\n|\r?\n\*\*|$)/.exec(note.body)?.[1];
  const text = why && !rule.includes(flat(why).slice(0, 40)) ? `${rule.replace(/[.;:,\s]+$/, "")}. Why: ${flat(why)}` : rule;
  return text.length > 900 ? `${text.slice(0, 897).trimEnd()}...` : text;
}

/** Look, and say what adoption would do. Reads through `fs` only; writes nothing anywhere. */
export async function planAdoption(input: PlanInput): Promise<AdoptPlan> {
  const fs = input.fs ?? diskAdoptFs();
  const root = input.root.replace(/\/+$/, "");
  const project = input.project ?? null;
  const projectsRoot = input.projectsRoot ?? claudeProjectsRoot();
  const state = input.state ?? { decisions: {} };
  const dirs = findClaudeProjects(fs, projectsRoot, [root, ...(input.worktrees ?? [])]);
  const repoFile = (path: string): string | undefined => fs.read(posix.join(root, path));

  const files: AdoptFile[] = [];
  const unchanged: string[] = [];
  const decisions: AdoptDecision[] = [];
  const skipped: AdoptSkip[] = [];
  const index = new Map<string, { file: string; title: string; description: string }>();
  const slugs = new Map<string, string>();
  const known = project ? state.decisions[project] ?? {} : {};
  const seenDecisions = new Set<string>();

  for (const dir of dirs) {
    const titles = indexTitles(fs.read(join(dir.path, "memory", "MEMORY.md")));
    for (const path of dir.memory) {
      const file = posix.basename(path);
      const text = fs.read(path);
      if (text === undefined) continue;
      const note = parseMemoryFile(file, text);
      if ("problem" in note) {
        skipped.push({ file, why: note.problem });
        continue;
      }
      const secrets = findSecrets(text);
      if (secrets.length) {
        skipped.push({ file, why: `looks like it holds a secret (${secrets.join(", ")}); take it out of the note and run this again` });
        continue;
      }
      const title = titles.get(file) ?? titleOf(note.slug);

      if (note.type === "feedback" || note.type === "user") {
        if (seenDecisions.has(file)) {
          skipped.push({ file, why: `another project directory has a note by this name (${dir.name}); the first one found is used` });
          continue;
        }
        seenDecisions.add(file);
        const before = known[file];
        const action = !before ? "record" : before.hash === note.hash ? "same" : "update";
        decisions.push({ file, title, text: decisionText(note), hash: note.hash, action, ...(action === "update" && before!.id ? { supersedes: before!.id } : {}), sourceRef: `claude-memory:${file}` });
        continue;
      }

      const target = `${CONTEXT_DIR}/${note.slug}.md`;
      if (slugs.has(note.slug)) {
        if (slugs.get(note.slug) !== note.hash) skipped.push({ file, why: `another project directory has a different note by this name (${dir.name}); the first one found is used` });
        continue;
      }
      slugs.set(note.slug, note.hash);
      const existing = repoFile(target);
      const mark = existing === undefined ? undefined : MARK.exec(existing);
      if (existing !== undefined && !mark) {
        skipped.push({ file, why: `${target} is in the repository and adoption did not write it; left alone` });
        continue;
      }
      index.set(`${note.slug}.md`, { file: `${note.slug}.md`, title, description: note.description });
      // the mark carries the note's hash: an adopted file somebody improved in the repository is not overwritten until the note itself changes
      if (mark && mark[2] === note.hash.slice(0, 16)) unchanged.push(target);
      else files.push({ path: target, content: contextFile(note, title), action: existing === undefined ? "write" : "update", kind: "context", about: note.description || title });
    }
  }

  // the index lists everything in the directory, hand-written notes and ones adopted from another machine included
  for (const name of fs.list(posix.join(root, CONTEXT_DIR))) {
    if (!name.endsWith(".md") || name === "README.md" || index.has(name)) continue;
    const text = repoFile(`${CONTEXT_DIR}/${name}`) ?? "";
    index.set(name, { file: name, title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? titleOf(name.replace(/\.md$/, "")), description: /^>\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "" });
  }
  if (index.size) {
    const content = contextIndex([...index.values()]);
    const existing = repoFile(CONTEXT_INDEX);
    if (existing === content) unchanged.push(CONTEXT_INDEX);
    else if (existing !== undefined && !existing.includes(INDEX_MARK)) skipped.push({ file: CONTEXT_INDEX, why: "it is in the repository and adoption did not write it; left alone, so the notes are not listed there" });
    else files.push({ path: CONTEXT_INDEX, content, action: existing === undefined ? "write" : "update", kind: "index", about: `lists ${index.size} note${index.size === 1 ? "" : "s"}, one line each` });
  }

  const transcripts = dirs.flatMap((d) => d.transcripts);
  const mined = input.transcripts === false ? { transcripts: 0, lines: 0, skippedLines: 0, bashCalls: 0, counts: [] } : await mineCommands(fs, transcripts.map((t) => t.path), [root, ...(input.worktrees ?? [])]);
  const drafted = draftProfile({ fs, root, counts: mined.counts });
  const existingProfile = repoFile(PROFILE_PATH);
  let profile: AdoptProfile = { ...drafted, exists: existingProfile !== undefined, diff: "" };
  const draftSecrets = findSecrets(drafted.json);
  if (draftSecrets.length) {
    skipped.push({ file: PROFILE_PATH, why: `the draft looks like it holds a secret (${draftSecrets.join(", ")}); not proposed` });
    profile = { draft: { setup: [], verify: [], tools: [], sets: {} }, json: "", problems: [], notes: drafted.notes, exists: profile.exists, diff: "" };
  } else if (drafted.json && existingProfile !== undefined) {
    // what the draft would add to the profile that is there; the file itself is never touched
    let current: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(existingProfile) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      /* reported below */
    }
    if (!current) profile.notes = [...profile.notes, `${PROFILE_PATH} is not a JSON object; the draft is shown whole`];
    const proposed = JSON.parse(drafted.json) as Record<string, unknown>;
    // the draft's keys go first, so a draft that only adds shows as added lines and no comma of the old file moves
    profile.diff = current ? lineDiff(`${JSON.stringify(current, null, 2)}\n`, `${JSON.stringify({ ...proposed, ...current, ...proposed }, null, 2)}\n`) : lineDiff("", drafted.json);
  } else if (drafted.json) {
    files.push({ path: PROFILE_PATH, content: drafted.json, action: "write", kind: "profile", about: `setup, verify, ${drafted.draft.tools.length} tool${drafted.draft.tools.length === 1 ? "" : "s"}, ${Object.keys(drafted.draft.sets).length} capability set${Object.keys(drafted.draft.sets).length === 1 ? "" : "s"}` });
  }

  const sum = (pick: (d: ClaudeProjectDir) => number): number => dirs.reduce((n, d) => n + pick(d), 0);
  const bytes = (d: ClaudeProjectDir, subagent: boolean): number => d.transcripts.filter((t) => t.subagent === subagent).reduce((n, t) => n + t.bytes, 0);
  return {
    root,
    project,
    found: {
      projectsRoot,
      dirs: dirs.map((d) => ({ name: d.name, kind: d.kind, transcripts: d.transcripts.filter((t) => !t.subagent).length, transcriptBytes: bytes(d, false), subagentTranscripts: d.transcripts.filter((t) => t.subagent).length, subagentBytes: bytes(d, true), memoryFiles: d.memory.length })),
      transcripts: transcripts.length,
      transcriptBytes: transcripts.reduce((n, t) => n + t.bytes, 0),
      memoryFiles: sum((d) => d.memory.length),
    },
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    unchanged: unchanged.sort(),
    decisions,
    skipped,
    commands: { transcripts: mined.transcripts, lines: mined.lines, skippedLines: mined.skippedLines, bashCalls: mined.bashCalls, top: mined.counts.slice(0, input.top ?? 25) },
    profile,
  };
}

export interface ApplyOptions {
  /** Only `getProject` and `decide` are used. */
  client: Pick<RelayClient, "getProject" | "decide">;
  /** Where the note-to-decision record is kept (default: relay's home). Tests pass their own. */
  state?: { read(): AdoptState; write(state: AdoptState): void };
  now?: () => Date;
}

export interface AdoptResult {
  /** The repository files for the caller to put where it wants them (a branch, the working tree). */
  files: Array<{ path: string; content: string }>;
  recorded: Array<{ file: string; id: number; action: "record" | "update" }>;
  /** Decisions that were planned and not recorded, with why. */
  notRecorded: AdoptSkip[];
}

/**
 * Record the plan's decisions, each once: a note that is already a decision under the same hash is skipped, one
 * that changed supersedes the decision it was. The record is written after every decision, so a run that stops
 * half way repeats nothing. The files are handed back untouched.
 */
export async function applyAdoption(plan: AdoptPlan, opts: ApplyOptions): Promise<AdoptResult> {
  const store = opts.state ?? { read: () => readAdoptState(), write: (s: AdoptState) => writeAdoptState(s) };
  const out: AdoptResult = { files: plan.files.map(({ path, content }) => ({ path, content })), recorded: [], notRecorded: [] };
  const todo = plan.decisions.filter((d) => d.action !== "same");
  if (!todo.length) return out;
  const project = plan.project;
  const why = !project ? "no project to record it for" : !(await opts.client.getProject(project)) ? `relay does not know the project '${project}' yet (relay link registers it)` : undefined;
  if (why || !project) {
    out.notRecorded = todo.map((d) => ({ file: d.file, why: why ?? "no project" }));
    return out;
  }
  const state = store.read();
  const mine = (state.decisions[project] ??= {});
  for (const d of todo) {
    // the plan may be older than the record: another run could have recorded this note since
    const before = mine[d.file];
    if (before?.hash === d.hash) continue;
    if (findSecrets(d.text).length) {
      out.notRecorded.push({ file: d.file, why: "looks like it holds a secret" });
      continue;
    }
    const supersedes = before?.id || d.supersedes;
    try {
      const row = await opts.client.decide({ project, text: d.text, source: ADOPT_SOURCE, sourceRef: d.sourceRef, ...(supersedes ? { supersedesId: supersedes } : {}) });
      mine[d.file] = { hash: d.hash, id: row.id, at: (opts.now?.() ?? new Date()).toISOString() };
      store.write(state);
      out.recorded.push({ file: d.file, id: row.id, action: supersedes ? "update" : "record" });
    } catch (e) {
      out.notRecorded.push({ file: d.file, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

const size = (n: number): string => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The plan as one report, grouped by what will happen. */
export function renderAdoptPlan(plan: AdoptPlan): string {
  const out: string[] = [];
  const f = plan.found;
  out.push(`${plan.root}${plan.project ? ` (project ${plan.project})` : ""}`);
  if (!f.dirs.length) out.push(`Claude Code has no project directory for it under ${f.projectsRoot}.`);
  else {
    const worktrees = f.dirs.filter((d) => d.kind === "worktree").length;
    const subagents = f.dirs.reduce((n, d) => n + d.subagentTranscripts, 0);
    out.push(`Claude Code: ${f.dirs.length} project director${f.dirs.length === 1 ? "y" : "ies"} under ${f.projectsRoot}${worktrees ? ` (${worktrees} of them worktrees)` : ""}, ${f.transcripts} transcript${f.transcripts === 1 ? "" : "s"} (${size(f.transcriptBytes)}${subagents ? `, ${subagents} of them subagents'` : ""}), ${f.memoryFiles} memory note${f.memoryFiles === 1 ? "" : "s"}`);
  }

  const context = plan.files.filter((x) => x.kind !== "profile");
  const same = plan.unchanged.length;
  out.push("", `Repository files (${context.length} to write${same ? `, ${same} already current` : ""}): notes of type project and reference, under ${CONTEXT_DIR}/`);
  for (const x of context) out.push(`  ${x.action.padEnd(6)} ${x.path}  ${cut(x.about, 100)}`);

  const todo = plan.decisions.filter((d) => d.action !== "same");
  const done = plan.decisions.length - todo.length;
  out.push("", `Decisions (${todo.length} to record${done ? `, ${done} already recorded` : ""}): notes of type feedback and user, in relay's memory${plan.project ? ` for ${plan.project}` : ""}`);
  if (todo.length && !plan.project) out.push("  no project: they cannot be recorded until the repository is linked (relay link)");
  for (const d of todo) out.push(`  ${d.action.padEnd(6)} ${d.file}  ${cut(d.text, 100)}`);

  out.push("", `Skipped (${plan.skipped.length})`);
  for (const s of plan.skipped) out.push(`  ${s.file}  ${s.why}`);

  const c = plan.commands;
  const p = plan.profile;
  out.push("", `Profile draft (${PROFILE_PATH}): from ${c.bashCalls} Bash call${c.bashCalls === 1 ? "" : "s"} in ${c.transcripts} transcript${c.transcripts === 1 ? "" : "s"}${c.skippedLines ? ` (${c.skippedLines} oversized line${c.skippedLines === 1 ? "" : "s"} not read)` : ""}`);
  if (c.top.length) {
    out.push("  most run:");
    for (const t of c.top.slice(0, 12)) out.push(`    ${String(t.count).padStart(5)}  ${t.command}  (${t.sessions} session${t.sessions === 1 ? "" : "s"})`);
  }
  if (!p.json) out.push("  nothing to propose: no command was run often enough, and the repository names no checks");
  else if (p.exists) {
    out.push(p.diff ? `  the repository has a profile; it is left alone. What the draft would add (+) or change (-):` : "  the repository has a profile, and the draft adds nothing to it");
    if (p.diff) out.push(...p.diff.split("\n").map((l) => `    ${l}`));
  } else {
    out.push("  the repository has none; this would be written:");
    out.push(...p.json.trimEnd().split("\n").map((l) => `    ${l}`));
  }
  for (const problem of p.problems) out.push(`  problem: ${problem}`);
  for (const note of p.notes) out.push(`  note: ${note}`);
  return out.join("\n");
}
