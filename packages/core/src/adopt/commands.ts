/**
 * Which commands were run in a project, counted from Claude Code's transcripts with no model call: every Bash tool
 * call whose working directory is inside the repository, cut into its shell segments, each reduced to what names the
 * command (`node scripts/sync.mjs`, `npm run build`, `pnpm -r typecheck`, `npx tsc --noEmit`). Arguments are dropped
 * on purpose: they are where an order number, an email address or a key would be, and the count needs none of them.
 */
import { posix } from "node:path";
import type { AdoptFs } from "./fs.ts";
import { eachLine } from "./fs.ts";

const WRAPPERS = new Set(["time", "command", "exec", "nohup", "corepack", "env"]);
const SCRIPT_PATH = /^[\w@.-]+(?:\/[\w@.-]+)*\.(?:[mc]?[jt]sx?)$/;
const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.-]+)?$/;
const LONG_FLAG = /^--[A-Za-z][\w-]*$/;
const SUBCOMMAND = /^[a-z][a-z-]{0,23}$/;

/** A shell command cut where one command ends and the next begins (`&&`, `||`, `;`, `|`, a newline), quotes respected. */
export function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') cur += c + (command[++i] ?? "");
      else {
        if (c === quote) quote = "";
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "\\") cur += c + (command[++i] ?? "");
    else if (c === "\n" || c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      if (c === "&" || command[i + 1] === "|") i++;
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of one segment; a quoted word keeps its text and loses its quotes. */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const relScript = (w: string | undefined): string | undefined => {
  const p = (w ?? "").replace(/^\.\//, "");
  return SCRIPT_PATH.test(p) && !p.split("/").includes("..") ? p : undefined;
};

/** What a segment runs, or undefined when it is none of the four kinds relay counts. */
export function commandKey(segment: string): string | undefined {
  let w = words(segment);
  while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]!) || WRAPPERS.has(w[0]!))) w = w.slice(1);
  const [bin, ...rest] = w;
  if (bin === "node") {
    if (rest[0] === "--test") return "node --test";
    // `node -e`, `--eval`, `-p`: the "script" is code on the command line, not a file
    if (rest.some((a) => /^(-e|--eval|-p|--print)$/.test(a))) return undefined;
    // the first plain word is the script, unless it is a switch's value (`--env-file .env scripts/x.mjs`)
    const plain = rest.filter((a) => !a.startsWith("-"));
    const script = relScript(plain[0]) ?? plain.map(relScript).find(Boolean);
    return script ? `node ${script}` : undefined;
  }
  if (bin === "npm") {
    const [sub, name] = rest.filter((a) => !a.startsWith("-"));
    if ((sub === "run" || sub === "run-script") && name && SCRIPT_NAME.test(name)) return `npm run ${name}`;
    if (sub === "test" || sub === "t") return "npm test";
    if (sub === "ci") return "npm ci";
    if ((sub === "install" || sub === "i") && !name) return "npm install";
    return undefined;
  }
  if (bin === "pnpm") {
    const flags: string[] = [];
    let i = 0;
    for (; i < rest.length && rest[i]!.startsWith("-"); i++) {
      const f = rest[i]!;
      if (f === "-r" || f === "--recursive" || f === "-w" || f === "--workspace-root") flags.push(f);
      else if ((f === "--filter" || f === "-F" || f === "-C" || f === "--dir") && rest[i + 1] && /^[\w@./*{}-]+$/.test(rest[i + 1]!)) flags.push(f, rest[++i]!);
      else if (/^--filter=[\w@./*{}-]+$/.test(f)) flags.push(f);
      else return undefined;
    }
    let name = rest[i];
    if (name === "run") name = rest[i + 1];
    if (!name || !SCRIPT_NAME.test(name)) return undefined;
    if (name === "install" || name === "i") return rest.includes("--frozen-lockfile") ? "pnpm install --frozen-lockfile" : "pnpm install";
    if (["exec", "dlx", "add", "remove", "rm", "up", "update", "why", "ls", "list", "store", "config", "link", "unlink", "publish", "pack", "init", "create", "audit", "outdated", "env", "setup", "patch"].includes(name)) return undefined;
    return ["pnpm", ...flags, name].join(" ");
  }
  if (bin === "npx") {
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith("-")) i += rest[i] === "-p" || rest[i] === "--package" ? 2 : 1;
    const tool = rest[i];
    if (!tool || !PACKAGE_NAME.test(tool)) return undefined;
    const tail = rest.slice(i + 1);
    if (tool === "tsx" || tool === "ts-node") {
      const script = relScript(tail.find((a) => !a.startsWith("-")));
      return script ? `npx ${tool} ${script}` : undefined;
    }
    // the tool's own subcommand and its bare switches say which check it is (`vitest run`, `tsc --noEmit`); stop at the first word that could be a value
    const keep: string[] = [];
    let k = 0;
    for (; k < tail.length && k < 2 && SUBCOMMAND.test(tail[k]!); k++) keep.push(tail[k]!);
    for (; k < tail.length && LONG_FLAG.test(tail[k]!); k++) keep.push(tail[k]!);
    return ["npx", tool, ...keep].join(" ");
  }
  return undefined;
}

/**
 * The checkout a directory is in: one of `roots`, or one of Claude Code's own worktrees under a root
 * (`<root>/.claude/worktrees/<name>`), which may be long gone from disk while its transcripts remain.
 */
export function checkoutOf(dir: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const r of roots) {
    const root = r.replace(/\/+$/, "");
    if (dir !== root && !dir.startsWith(`${root}/`)) continue;
    const wt = /^\.claude\/worktrees\/[^/]+/.exec(dir.slice(root.length + 1));
    const at = wt ? `${root}/${wt[0]}` : root;
    if (!best || at.length > best.length) best = at;
  }
  return best;
}

/**
 * The keys of one Bash call run from `cwd`, each as it would be typed from the checkout's root: a script run after
 * `cd scripts` is counted by its path from the root, a package script run from a subdirectory is not counted (it is
 * another package's), and counting stops at a `cd` that leaves the checkout or cannot be followed.
 */
export function commandKeys(command: string, cwd: string, roots: readonly string[]): string[] {
  const root = checkoutOf(cwd, roots);
  if (!root) return [];
  const keys: string[] = [];
  let dir = cwd.replace(/\/+$/, "");
  for (const raw of shellSegments(command)) {
    const segment = raw.replace(/^\(+\s*/, "").replace(/\s*\)+$/, "");
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(segment);
    if (cd) {
      const to = cd[1] ?? cd[2] ?? cd[3]!;
      if (/^[~$-]/.test(to)) break;
      dir = posix.resolve(dir, to);
      if (checkoutOf(dir, [root]) !== root) break;
      continue;
    }
    const key = commandKey(segment);
    if (!key) continue;
    if (dir === root) keys.push(key);
    else {
      const script = /^(node|npx tsx|npx ts-node) (\S+)$/.exec(key);
      if (script && script[2] !== "--test") keys.push(`${script[1]} ${posix.join(dir.slice(root.length + 1), script[2]!)}`);
    }
  }
  return keys;
}

/** The Bash calls on one transcript line, with the working directory they ran in. Undefined for every other line, most of them without parsing. */
export function bashCallsOf(line: Buffer): { cwd: string; commands: string[] } | undefined {
  if (!line.includes('"name":"Bash"')) return undefined;
  let o: { type?: unknown; cwd?: unknown; message?: { content?: unknown } };
  try {
    o = JSON.parse(line.toString("utf8")) as typeof o;
  } catch {
    return undefined;
  }
  if (o.type !== "assistant" || typeof o.cwd !== "string" || !Array.isArray(o.message?.content)) return undefined;
  const commands: string[] = [];
  for (const c of o.message.content as Array<{ type?: unknown; name?: unknown; input?: { command?: unknown } }>) {
    if (c?.type === "tool_use" && c.name === "Bash" && typeof c.input?.command === "string") commands.push(c.input.command);
  }
  return commands.length ? { cwd: o.cwd, commands } : undefined;
}

export interface CommandCount {
  command: string;
  /** How many times it was run. */
  count: number;
  /** In how many transcripts. */
  sessions: number;
}

export interface CommandMine {
  transcripts: number;
  lines: number;
  /** Lines too long to be a tool call, dropped unread. */
  skippedLines: number;
  bashCalls: number;
  counts: CommandCount[];
}

/** Count the commands run from inside `roots` (the repository and its worktrees) across the transcripts, most run first. */
export async function mineCommands(fs: AdoptFs, transcripts: readonly string[], roots: readonly string[]): Promise<CommandMine> {
  const totals = new Map<string, { count: number; sessions: number }>();
  const mine: CommandMine = { transcripts: 0, lines: 0, skippedLines: 0, bashCalls: 0, counts: [] };
  for (const path of transcripts) {
    const seen = new Set<string>();
    const r = await eachLine(fs.chunks(path), (line) => {
      const calls = bashCallsOf(line);
      if (!calls || !checkoutOf(calls.cwd, roots)) return;
      for (const command of calls.commands) {
        mine.bashCalls++;
        for (const key of commandKeys(command, calls.cwd, roots)) {
          const t = totals.get(key) ?? { count: 0, sessions: 0 };
          t.count++;
          if (!seen.has(key)) t.sessions++;
          seen.add(key);
          totals.set(key, t);
        }
      }
    });
    mine.transcripts++;
    mine.lines += r.lines;
    mine.skippedLines += r.skipped;
  }
  mine.counts = [...totals].map(([command, t]) => ({ command, ...t })).sort((a, b) => b.count - a.count || a.command.localeCompare(b.command));
  return mine;
}
