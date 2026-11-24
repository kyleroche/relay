/**
 * A first `.relay/project.json` for a project that has none, from what was actually run in it (commands.ts) and what
 * its repository says about itself: the checks its CI runs, its lockfile, its package scripts, and for the scripts
 * that were run most, the names of the environment variables they read and the hosts they call. Names only: no value
 * of any variable is read from anywhere. A draft for a person to edit in a pull request, in exactly the format
 * `steps/profile.ts` reads; `readProfile` is run over it before anyone sees it.
 */
import { posix } from "node:path";
import { JOB_ENV_STRIPPED } from "../work/env.ts";
import { PROFILE_PATH } from "../steps/index.ts";
import { readProfile, SET_NAME, type CapabilitySet, type ProfileTool } from "../steps/profile.ts";
import type { CommandCount } from "./commands.ts";
import type { AdoptFs } from "./fs.ts";

export interface ProfileDraft {
  setup: string[];
  verify: string[];
  tools: ProfileTool[];
  sets: Record<string, CapabilitySet>;
}

export interface DraftResult {
  draft: ProfileDraft;
  /** The draft as the file would hold it, empty keys left out; empty when there is nothing to propose. */
  json: string;
  /** What `readProfile` says about the draft. */
  problems: string[];
  /** Things the draft could not express, for the person who reviews it. */
  notes: string[];
}

const ONE_LINE = (c: string): boolean => c.length > 0 && c.length <= 400 && !/[\n\r\0]/.test(c);
const SETUP_RE = /^(?:npm (?:ci|install)|pnpm install(?: --frozen-lockfile)?|yarn install(?: --frozen-lockfile| --immutable)?)$/;
const CHECK_WORD = /\b(?:test|tests|lint|typecheck|type-check|tsc|check|build|vitest|jest|eslint|prettier|biome|playwright)\b/;
const RUNNER_RE = /^(?:npm (?:test|run [\w:.-]+)|pnpm |yarn |npx |node --test|node [\w./@-]+\.[mc]?[jt]s\b|make [\w-]+$|(?:\.\/)?scripts\/[\w./-]+\.sh\b)/;
const NOT_A_CHECK = /\b(?:deploy|publish|release|login|upload)\b|\$\{\{|\$\(|`|[<>]|\bsecrets\./;
/** Variables every process has, or that say how to run rather than what to reach: never part of a capability set. */
const AMBIENT_ENV = new Set(["NODE_ENV", "CI", "HOME", "PATH", "PWD", "USER", "SHELL", "TERM", "TZ", "LANG", "DEBUG", "TMPDIR", "PORT", "HOST", "NODE_OPTIONS", "FORCE_COLOR", "NO_COLOR", "VERBOSE", "DRY_RUN"]);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,95}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The commands of a workflow's `run:` keys, one per line of a block. No YAML library: a `run:` key and its indented block are all that is read. */
export function workflowCommands(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const value = m[2]!.trim();
    if (value && !/^[|>][+-]?$/.test(value)) {
      out.push(value.replace(/^(["'])(.*)\1$/, "$2"));
      continue;
    }
    const indent = m[1]!.length;
    let joined = "";
    for (i++; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() && line.length - line.trimStart().length <= indent) break;
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      // a line that ends in a backslash continues on the next
      if (t.endsWith("\\")) joined += `${t.slice(0, -1).trimEnd()} `;
      else {
        out.push(joined + t);
        joined = "";
      }
    }
    i--;
  }
  return out;
}

/** The first thing a script says about itself: the opening line of its leading comment. */
export function scriptAbout(text: string): string {
  const body = text.replace(/^#!.*\r?\n/, "").trimStart();
  const block = /^\/\*\*?([\s\S]*?)\*\//.exec(body);
  const lines = block ? block[1]!.split(/\r?\n/).map((l) => l.replace(/^\s*\*?\s?/, "")) : (/^(?:\/\/.*(?:\r?\n|$))+/.exec(body)?.[0] ?? "").split(/\r?\n/).map((l) => l.replace(/^\/\/\s?/, ""));
  const first: string[] = [];
  for (const l of lines) {
    if (!l.trim()) {
      if (first.length) break;
      continue;
    }
    if (l.trim().startsWith("@")) break;
    first.push(l.trim());
  }
  return first.join(" ").replace(/\s+/g, " ").slice(0, 300);
}

/** The files a script is made of: itself and what it imports by relative path, two levels down. */
function scriptFiles(fs: AdoptFs, root: string, script: string): string[] {
  const seen = new Map<string, string>();
  const visit = (rel: string, depth: number): void => {
    if (seen.has(rel) || seen.size >= 40) return;
    const text = fs.read(posix.join(root, rel));
    if (text === undefined) return;
    seen.set(rel, text);
    if (depth >= 2) return;
    for (const m of text.matchAll(/(?:from\s+|import\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(rel), m[1]!));
      if (target.startsWith("..")) continue;
      const hit = [target, `${target}.js`, `${target}.mjs`, `${target}.ts`, `${target}/index.js`, `${target}/index.ts`].find((c) => fs.read(posix.join(root, c)) !== undefined);
      if (hit) visit(hit, depth + 1);
    }
  };
  visit(script, 0);
  return [...seen.values()];
}

/** The names of the environment variables a source text reads, and the hosts of the URLs it spells out in strings. */
export function reachOf(text: string): { env: string[]; hosts: string[] } {
  const env = new Set<string>();
  for (const m of text.matchAll(/process\.env\.([A-Za-z_]\w*)|process\.env\[\s*["']([A-Za-z_]\w*)["']\s*\]/g)) env.add(m[1] ?? m[2]!);
  for (const m of text.matchAll(/\{([^{}]{1,400})\}\s*=\s*process\.env\b/g)) for (const part of m[1]!.split(",")) env.add(part.split(/[:=]/)[0]!.trim());
  const hosts = new Set<string>();
  for (const m of text.matchAll(/["'`]https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1]!.toLowerCase());
  return { env: [...env].filter((e) => ENV_NAME.test(e)).sort(), hosts: [...hosts].filter((h) => HOST.test(h)).sort() };
}

const toolName = (from: string, taken: Set<string>): string => {
  const base = (from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "") || "tool").slice(0, 44);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
};

export interface DraftInput {
  fs: AdoptFs;
  /** The repository's root. */
  root: string;
  counts: readonly CommandCount[];
  /** How many tools at most (default 12), and how often one must have been run to count (default 2). */
  maxTools?: number;
  minRuns?: number;
}

export function draftProfile(i: DraftInput): DraftResult {
  const { fs, root } = i;
  const notes: string[] = [];
  const minRuns = i.minRuns ?? 2;
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.read(posix.join(root, "package.json")) ?? "{}") as { scripts?: Record<string, unknown> };
    scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    notes.push("package.json is not JSON; its scripts were not read");
  }

  // what CI runs is what the project itself calls a check; a workflow that never runs on a push or a pull request is a deploy or a schedule
  const ci: string[] = [];
  const wfDir = posix.join(root, ".github", "workflows");
  for (const name of fs.list(wfDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = fs.read(posix.join(wfDir, name)) ?? "";
    if (/\b(?:pull_request|push)\b/.test(text)) ci.push(...workflowCommands(text));
  }
  const ciSetup = ci.filter((c) => SETUP_RE.test(c));
  const lock = fs.read(posix.join(root, "pnpm-lock.yaml")) !== undefined ? "pnpm install --frozen-lockfile" : fs.read(posix.join(root, "package-lock.json")) !== undefined ? "npm ci" : fs.read(posix.join(root, "yarn.lock")) !== undefined ? "yarn install --frozen-lockfile" : undefined;
  const setup = [...new Set(ciSetup.length ? ciSetup : lock ? [lock] : [])].slice(0, 4);

  const isCheck = (c: string): boolean => ONE_LINE(c) && RUNNER_RE.test(c) && CHECK_WORD.test(c) && !NOT_A_CHECK.test(c) && !SETUP_RE.test(c);
  const ciVerify = [...new Set(ci.filter(isCheck))];
  const defined = (c: string): boolean => {
    const m = /^npm run ([\w:.-]+)$/.exec(c) ?? /^pnpm (?:(?:-r|--recursive|-w|--workspace-root) )*([\w:.-]+)$/.exec(c);
    return !m || m[1]! in scripts;
  };
  const ran = i.counts.filter((c) => c.count >= minRuns && defined(c.command) && (c.command !== "npm test" || "test" in scripts));
  const verify = (ciVerify.length ? ciVerify : ran.filter((c) => isCheck(c.command) && !/^node (?!--test)/.test(c.command)).map((c) => c.command)).slice(0, ciVerify.length ? 8 : 4);

  const taken = new Set<string>();
  const tools: ProfileTool[] = [];
  const reach = new Map<string, { env: string[]; hosts: string[] }>();
  for (const c of ran) {
    if (tools.length >= (i.maxTools ?? 12)) break;
    if (setup.includes(c.command) || verify.includes(c.command) || SETUP_RE.test(c.command)) continue;
    const node = /^(?:node|npx tsx|npx ts-node) (\S+)$/.exec(c.command);
    const npm = /^npm run ([\w:.-]+)$/.exec(c.command);
    const fallback = `Run ${c.count} times in ${c.sessions} Claude Code session${c.sessions === 1 ? "" : "s"}; say what it is for.`;
    if (node && node[1] !== "--test") {
      const text = fs.read(posix.join(root, node[1]!));
      if (text === undefined) continue; // run once upon a time, gone from the repository since
      const name = toolName(posix.basename(node[1]!).replace(/\.[^.]+$/, ""), taken);
      tools.push({ name, run: c.command, about: scriptAbout(text) || fallback });
      const r = reachOf(scriptFiles(fs, root, node[1]!).join("\n"));
      const barred = r.env.filter((e) => (JOB_ENV_STRIPPED as readonly string[]).includes(e));
      if (barred.length) notes.push(`${node[1]} reads ${barred.join(", ")}, which no job may carry; it is in no set`);
      const env = r.env.filter((e) => !AMBIENT_ENV.has(e) && !barred.includes(e) && !e.startsWith("npm_"));
      if (env.length || r.hosts.length) reach.set(name, { env, hosts: r.hosts });
    } else if (npm) {
      tools.push({ name: toolName(npm[1]!, taken), run: c.command, about: `package.json script: ${scripts[npm[1]!]!.replace(/\s+/g, " ").slice(0, 200)}` });
    }
  }

  // tools that reach the same things share one set, named for what its variables have in common
  const sets: Record<string, CapabilitySet> = {};
  const byReach = new Map<string, string>();
  for (const tool of tools) {
    const r = reach.get(tool.name);
    if (!r) continue;
    const key = JSON.stringify(r);
    let set = byReach.get(key);
    if (!set) {
      const prefixes = new Set(r.env.map((e) => e.split("_")[0]!.toLowerCase()));
      const shared = prefixes.size === 1 ? [...prefixes][0]! : "";
      const base = SET_NAME.test(shared) && shared.length > 1 ? shared : tool.name;
      set = base;
      for (let n = 2; sets[set]; n++) set = `${base}-${n}`;
      sets[set] = r;
      byReach.set(key, set);
    }
    tool.needs = set;
  }

  const draft: ProfileDraft = { setup, verify, tools, sets };
  const doc: Record<string, unknown> = {};
  if (setup.length) doc.setup = setup;
  if (verify.length) doc.verify = verify;
  if (tools.length) doc.tools = tools;
  if (Object.keys(sets).length) doc.sets = sets;
  const json = Object.keys(doc).length ? `${JSON.stringify(doc, null, 2)}\n` : "";
  const problems = json ? readProfile({ list: () => [], read: (p) => (p === PROFILE_PATH ? json : undefined), label: (p) => `the draft of ${p}` }).problems : [];
  return { draft, json, problems, notes };
}

/** `a` to `b`, line by line: unchanged lines with two spaces in front, removed with `- `, added with `+ `. Empty when they are the same. */
export function lineDiff(a: string, b: string): string {
  if (a === b) return "";
  const x = a.split("\n");
  const y = b.split("\n");
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let p = x.length - 1; p >= 0; p--) for (let q = y.length - 1; q >= 0; q--) lcs[p]![q] = x[p] === y[q] ? lcs[p + 1]![q + 1]! + 1 : Math.max(lcs[p + 1]![q]!, lcs[p]![q + 1]!);
  const out: string[] = [];
  let p = 0;
  let q = 0;
  while (p < x.length && q < y.length) {
    if (x[p] === y[q]) {
      out.push(`  ${x[p++]}`);
      q++;
    } else if (lcs[p + 1]![q]! >= lcs[p]![q + 1]!) out.push(`- ${x[p++]}`);
    else out.push(`+ ${y[q++]}`);
  }
  while (p < x.length) out.push(`- ${x[p++]}`);
  while (q < y.length) out.push(`+ ${y[q++]}`);
  return out.join("\n");
}
