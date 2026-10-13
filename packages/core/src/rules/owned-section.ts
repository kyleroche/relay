/**
 * The owned section: a marker-delimited block relay maintains inside a repo's AGENTS.md and CLAUDE.md so every CLI
 * reads `relay.md` without being told. relay rewrites only the text between `<!-- relay:begin -->` and
 * `<!-- relay:end -->`; everything else in the file is the user's. Hashes of what relay last wrote are kept in
 * `.relay/rules.json` so a local edit inside the markers is detected and never clobbered without `force`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "../util.ts";

export const BEGIN = "<!-- relay:begin -->";
export const END = "<!-- relay:end -->";
export const OWNED_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export type OwnedFile = (typeof OWNED_FILES)[number];
export const STATE_FILE = join(".relay", "rules.json");

export interface RulesState {
  version: 1;
  /** Project slug this repo is linked to. */
  project?: string;
  /** owner/name */
  repo?: string;
  /** sha256 of the section body relay last wrote, per file. */
  sections: Partial<Record<OwnedFile, { hash: string; updated_at: string }>>;
  [k: string]: unknown;
}

export const MEMORY_TOOLS = ["relay_recall", "relay_decide", "relay_prefer", "relay_guidance", "relay_brief", "relay_feed", "relay_project"] as const;

/** The standard section body (without markers). */
export function renderOwnedSection(opts: { project?: string } = {}): string {
  const who = opts.project ? ` (project \`${opts.project}\`)` : "";
  return [
    `This repository is managed with relay${who}. Read \`relay.md\` before making changes; it holds the current decisions and preferences for this project.`,
    `Issues labelled \`agent:claude\`, \`agent:codex\` or \`agent:grok\` are implemented by lanes on self-hosted runners that open pull requests from \`relay/<lane>-<issue>\` branches.`,
    `Memory tools (MCP server \`relay\`): ${MEMORY_TOOLS.map((t) => `\`${t}\``).join(", ")}. Call \`relay_recall\` before choosing an approach and \`relay_decide\` when you settle one.`,
  ].join("\n");
}

export interface SectionSplit {
  before: string;
  inner: string;
  after: string;
}

/** Locate the owned section in a file's text. Null when the markers are absent (or malformed). */
export function findOwnedSection(text: string): SectionSplit | null {
  const b = text.indexOf(BEGIN);
  if (b < 0) return null;
  const e = text.indexOf(END, b + BEGIN.length);
  if (e < 0) return null;
  return { before: text.slice(0, b), inner: text.slice(b + BEGIN.length, e).replace(/^\n/, "").replace(/\n$/, ""), after: text.slice(e + END.length) };
}

const wrap = (body: string): string => `${BEGIN}\n${body}\n${END}`;

/** True when CLAUDE.md is nothing but an `@AGENTS.md` include (then AGENTS.md carries the section). */
export function isIncludeOnly(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length === 1 && /^@\.?\/?AGENTS\.md$/.test(lines[0]!);
}

export function readRulesState(root: string): RulesState {
  const p = join(root, STATE_FILE);
  if (!existsSync(p)) return { version: 1, sections: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<RulesState>;
    return { ...j, version: 1, sections: j.sections ?? {} };
  } catch {
    return { version: 1, sections: {} };
  }
}

export function writeRulesState(root: string, state: RulesState): void {
  const p = join(root, STATE_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}

export type SectionAction = "created" | "appended" | "updated" | "unchanged" | "skipped-include" | "refused-local-edit" | "removed" | "absent";

export interface SectionResult {
  file: OwnedFile;
  action: SectionAction;
  detail?: string;
}

export interface InstallOptions {
  /** Section body; defaults to renderOwnedSection(). */
  body?: string;
  project?: string;
  repo?: string;
  /** Overwrite a locally edited section. */
  force?: boolean;
  /** Which files to maintain; default both. */
  files?: readonly OwnedFile[];
  /** Create CLAUDE.md when absent (default: create AGENTS.md always, CLAUDE.md only when it exists). */
  createClaudeMd?: boolean;
}

/**
 * Install or update the owned section in AGENTS.md and CLAUDE.md under `root`.
 * - missing file: created with the section (CLAUDE.md only when createClaudeMd or it already exists)
 * - markers missing: section appended at the end
 * - markers present, body matches the recorded hash: rewritten (or unchanged)
 * - markers present, body differs from the recorded hash and from the new body: refused unless force
 * - CLAUDE.md that is a one-line `@AGENTS.md` include: left alone
 */
export function installOwnedSection(root: string, opts: InstallOptions = {}): SectionResult[] {
  const body = opts.body ?? renderOwnedSection(opts.project ? { project: opts.project } : {});
  const newHash = sha256(body);
  const state = readRulesState(root);
  if (opts.project) state.project = opts.project;
  if (opts.repo) state.repo = opts.repo;
  const results: SectionResult[] = [];
  const now = new Date().toISOString();

  for (const file of opts.files ?? OWNED_FILES) {
    const path = join(root, file);
    const exists = existsSync(path);
    if (!exists) {
      if (file === "CLAUDE.md" && !opts.createClaudeMd) {
        results.push({ file, action: "absent", detail: "not created; AGENTS.md carries the section" });
        continue;
      }
      writeFileSync(path, `# ${file === "AGENTS.md" ? "AGENTS.md" : "CLAUDE.md"}\n\n${wrap(body)}\n`);
      state.sections[file] = { hash: newHash, updated_at: now };
      results.push({ file, action: "created" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (file === "CLAUDE.md" && isIncludeOnly(text)) {
      results.push({ file, action: "skipped-include", detail: "CLAUDE.md includes AGENTS.md; left as is" });
      continue;
    }
    const split = findOwnedSection(text);
    if (!split) {
      const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      writeFileSync(path, `${text}${sep}${wrap(body)}\n`);
      state.sections[file] = { hash: newHash, updated_at: now };
      results.push({ file, action: "appended" });
      continue;
    }
    const currentHash = sha256(split.inner);
    if (currentHash === newHash) {
      if (state.sections[file]?.hash !== newHash) state.sections[file] = { hash: newHash, updated_at: now };
      results.push({ file, action: "unchanged" });
      continue;
    }
    const recorded = state.sections[file]?.hash;
    if (recorded && recorded !== currentHash && !opts.force) {
      results.push({ file, action: "refused-local-edit", detail: "the section was edited locally; re-run with --force to overwrite" });
      continue;
    }
    if (!recorded && !opts.force) {
      // Markers exist but relay never recorded writing them: someone else wrote this block. Do not clobber silently.
      results.push({ file, action: "refused-local-edit", detail: "a relay section exists that relay did not write; re-run with --force to take it over" });
      continue;
    }
    writeFileSync(path, `${split.before}${wrap(body)}${split.after}`);
    state.sections[file] = { hash: newHash, updated_at: now };
    results.push({ file, action: "updated" });
  }
  writeRulesState(root, state);
  return results;
}

/** Remove the owned section (markers included) from both files and forget the hashes. Files are never deleted. */
export function removeOwnedSection(root: string, opts: { files?: readonly OwnedFile[] } = {}): SectionResult[] {
  const state = readRulesState(root);
  const results: SectionResult[] = [];
  for (const file of opts.files ?? OWNED_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      results.push({ file, action: "absent" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const split = findOwnedSection(text);
    if (!split) {
      results.push({ file, action: "absent" });
      delete state.sections[file];
      continue;
    }
    const before = split.before.replace(/\n{2,}$/, "\n\n");
    const after = split.after.replace(/^\n+/, "");
    const out = (before + after).replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
    writeFileSync(path, out.trim() ? out : "");
    delete state.sections[file];
    results.push({ file, action: "removed" });
  }
  writeRulesState(root, state);
  return results;
}

/** Report the state of each file: present/absent markers, and whether the body matches what relay wrote. */
export function checkOwnedSection(root: string): Array<SectionResult & { localEdit: boolean }> {
  const state = readRulesState(root);
  return OWNED_FILES.map((file) => {
    const path = join(root, file);
    if (!existsSync(path)) return { file, action: "absent" as const, localEdit: false };
    const text = readFileSync(path, "utf8");
    if (file === "CLAUDE.md" && isIncludeOnly(text)) return { file, action: "skipped-include" as const, localEdit: false };
    const split = findOwnedSection(text);
    if (!split) return { file, action: "absent" as const, localEdit: false, detail: "markers missing; relay will not write here" };
    const recorded = state.sections[file]?.hash;
    const localEdit = !!recorded && recorded !== sha256(split.inner);
    return { file, action: localEdit ? ("refused-local-edit" as const) : ("unchanged" as const), localEdit };
  });
}
