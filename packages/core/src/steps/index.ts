/**
 * Steps: named instructions a lane runs at a fixed point of a task (docs/STEPS.md). One Markdown file each, with
 * frontmatter that says when it runs and how, and a body that is the instruction.
 *
 *   before-pr   in the same clone, after the lane's work and before the commit (remove-yap)
 *   after-pr    as a task of its own once the pull request is up, on another lane by default (eval); its findings
 *               go back to the thread and the lane that did the work answers them with the `respond` step
 *   respond     the answer to an after-pr step's findings, on the branch as it was left (eval-respond)
 *   task        not attached to another task: `relay steps run <name>` opens a task whose text is the step (cleanup)
 *
 * Three layers, nearest wins by name: the steps relay ships, the user's (`~/.harness/steps`), the project's
 * (`.relay/steps` in the repository). A project runs the ones its profile lists (`.relay/project.json`, `steps`), in
 * that order. During a job both the profile and the project's steps are read from the default branch, never from the
 * task's working tree, so a task cannot rewrite the steps that judge it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isLaneName } from "../tasks/lanes.ts";

export const STEP_WHENS = ["before-pr", "after-pr", "respond", "task"] as const;
export type StepWhen = (typeof STEP_WHENS)[number];
export type StepSource = "relay" | "user" | "project";
export const STEP_NAME = /^[a-z][a-z0-9-]{0,47}$/;
export const STEPS_DIR = ".relay/steps";
export const PROFILE_PATH = ".relay/project.json";
/** The step that answers an after-pr step's findings: `<name>-respond` when there is one, else this. */
export const DEFAULT_RESPOND_STEP = "eval-respond";

export interface Step {
  name: string;
  description: string;
  when: StepWhen;
  /** `same`: the lane that did the work. `other`: a code lane that did not. `any`, or a lane by name. */
  lane: string;
  /** The model the lane is asked for; the lane's own without it. */
  model?: string;
  /** `read-only`: the lane may read and run checks, and nothing it changes is kept. */
  mode: "edit" | "read-only";
  /** The instruction. `{{base}}` is replaced with the branch the work started from. */
  body: string;
  source: StepSource;
  /** Where it was read from, for `relay steps ls`. */
  path: string;
}

export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepError";
  }
}

/** A step file: `---`, `key: value` lines, `---`, then the body. Unknown keys are refused, so a typo is not a silent default. */
export function parseStep(text: string, at: { name: string; source: StepSource; path: string }): Step {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!m) throw new StepError(`${at.path}: a step starts with a frontmatter block between two --- lines`);
  const fields: Record<string, string> = {};
  for (const raw of m[1]!.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new StepError(`${at.path}: cannot read the frontmatter line '${line}' (expected key: value)`);
    fields[kv[1]!] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  const known = ["name", "description", "when", "lane", "model", "mode"];
  const extra = Object.keys(fields).filter((k) => !known.includes(k));
  if (extra.length) throw new StepError(`${at.path}: unknown frontmatter ${extra.join(", ")} (a step has ${known.join(", ")})`);
  const name = fields.name ?? at.name;
  if (!STEP_NAME.test(name)) throw new StepError(`${at.path}: '${name}' is not a step name (lowercase letters, digits and dashes, a letter first)`);
  if (name !== at.name) throw new StepError(`${at.path}: the file is ${at.name}.md but its name is '${name}'; they must match`);
  const when = fields.when as StepWhen | undefined;
  if (!when || !(STEP_WHENS as readonly string[]).includes(when)) throw new StepError(`${at.path}: when must be one of ${STEP_WHENS.join(", ")}`);
  const mode = (fields.mode ?? "edit") as Step["mode"];
  if (mode !== "edit" && mode !== "read-only") throw new StepError(`${at.path}: mode must be edit or read-only`);
  const lane = fields.lane ?? (when === "after-pr" ? "other" : when === "task" ? "any" : "same");
  if (lane !== "same" && lane !== "other" && !isLaneName(lane)) throw new StepError(`${at.path}: lane must be same, other, any or a lane name`);
  if (when === "task" && (lane === "same" || lane === "other")) throw new StepError(`${at.path}: a task step has no other lane to refer to; use any or a lane name`);
  const body = m[2]!.trim();
  if (!body) throw new StepError(`${at.path}: the step has no instruction under its frontmatter`);
  return { name, description: fields.description ?? "", when, lane, ...(fields.model ? { model: fields.model } : {}), mode, body, source: at.source, path: at.path };
}

/** Where a step layer's files come from: a directory on disk, or a path at a git ref. */
export interface StepFiles {
  list(dir: string): string[];
  read(path: string): string | undefined;
  /** How a path is shown to a person. */
  label(path: string): string;
}

export const diskFiles = (root: string): StepFiles => ({
  list: (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).sort() : []),
  read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined),
  label: (path) => join(root, path),
});

/** Files as they are at a ref of a clone (`origin/main`), whatever the working tree holds. */
export function gitFiles(dir: string, ref: string): StepFiles {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  };
  return {
    list: (d) => (git(["ls-tree", "--name-only", `${ref}:${d}`]) ?? "").split("\n").filter(Boolean).sort(),
    read: (path) => git(["show", `${ref}:${path}`]),
    label: (path) => `${path} at ${ref}`,
  };
}

export interface StepLayer {
  source: StepSource;
  files: StepFiles;
  /** The directory inside `files` that holds the `*.md` step files. */
  dir: string;
}

export interface StepLibrary {
  steps: Map<string, Step>;
  /** Files that could not be read as steps, with why. A broken file never hides a good one of an outer layer silently: it is reported. */
  problems: string[];
}

/** Every step by name, from the outermost layer to the nearest: a later layer's step replaces an earlier one's. */
export function loadSteps(layers: StepLayer[]): StepLibrary {
  const steps = new Map<string, Step>();
  const problems: string[] = [];
  for (const layer of layers) {
    for (const file of layer.files.list(layer.dir)) {
      if (!file.endsWith(".md")) continue;
      const path = layer.dir ? `${layer.dir}/${file}` : file;
      const text = layer.files.read(path);
      if (text === undefined) continue;
      try {
        const step = parseStep(text, { name: file.slice(0, -3), source: layer.source, path: layer.files.label(path) });
        steps.set(step.name, step);
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { steps, problems };
}

/** What a project's profile says about steps. The rest of the profile (setup, verify, tools, capability sets) is read elsewhere. */
export interface StepsProfile {
  /** The steps the project runs, in order. */
  steps: string[];
  problems: string[];
}

export function readStepsProfile(files: StepFiles): StepsProfile {
  const text = files.read(PROFILE_PATH);
  if (text === undefined) return { steps: [], problems: [] };
  try {
    const j = JSON.parse(text) as { steps?: unknown };
    if (j.steps === undefined) return { steps: [], problems: [] };
    if (!Array.isArray(j.steps) || j.steps.some((s) => typeof s !== "string")) return { steps: [], problems: [`${files.label(PROFILE_PATH)}: steps must be a list of step names`] };
    return { steps: [...new Set(j.steps as string[])], problems: [] };
  } catch (e) {
    return { steps: [], problems: [`${files.label(PROFILE_PATH)} is not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export interface ProjectSteps {
  /** The steps the project runs, in its order, each from its nearest layer. */
  enabled: Step[];
  library: Map<string, Step>;
  problems: string[];
}

/** The steps a project runs: its profile's list, looked up in the three layers. A name with no step is a problem, not a silent skip. */
export function projectSteps(i: { relayDir: string; userDir: string; project: StepFiles }): ProjectSteps {
  const lib = loadSteps([
    { source: "relay", files: diskFiles(i.relayDir), dir: "" },
    { source: "user", files: diskFiles(i.userDir), dir: "" },
    { source: "project", files: i.project, dir: STEPS_DIR },
  ]);
  const profile = readStepsProfile(i.project);
  const problems = [...lib.problems, ...profile.problems];
  const enabled: Step[] = [];
  for (const name of profile.steps) {
    const step = lib.steps.get(name);
    if (!step) problems.push(`${PROFILE_PATH} lists the step '${name}', and no step by that name exists (relay steps ls shows the ones that do)`);
    else if (step.when === "respond") problems.push(`${PROFILE_PATH} lists '${name}', which answers another step's findings and is not listed by itself`);
    else enabled.push(step);
  }
  return { enabled, library: lib.steps, problems };
}

/** The step that answers `step`'s findings: `<name>-respond` when the library has one, else the default. */
export function respondStep(library: Map<string, Step>, step: string): Step | undefined {
  const own = library.get(`${step}-respond`);
  return own?.when === "respond" ? own : library.get(DEFAULT_RESPOND_STEP);
}

/** A step's instruction with its placeholders filled. */
export const stepBody = (step: Step, vars: { base: string }): string => step.body.replaceAll("{{base}}", vars.base);

/** The lane an `other` step runs on: the first code lane a worker serves that is not the one that did the work, else that one again. */
export function otherLane(producer: string, served: readonly string[], prefer: readonly string[] = ["claude", "codex", "grok"]): string {
  return prefer.find((l) => l !== producer && served.includes(l)) ?? producer;
}
