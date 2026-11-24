/**
 * A project's profile, `.relay/project.json` (docs/PROFILE.md): what a worker that has never seen the project needs
 * besides the clone. It is checked into the repository and read from its default branch only, never from a task's
 * working tree, so a task cannot widen its own access: changing the profile takes a merged pull request.
 *
 *   steps    the steps the project runs around a task (steps/index.ts reads these)
 *   setup    commands that make a fresh clone ready (`npm ci`), run in the lane's sandbox before the work
 *   verify   the project's own checks, run in the same sandbox after the work; their result goes in the thread
 *   tools    the scripts that matter, by name: what to run, what it is for, and the capability set it needs
 *   skills   paths of skill files in the repository, listed for lanes that do not load them by themselves
 *   sets     capability sets: names of environment variables and network hosts, and nothing else. No value is
 *            ever in the file. A task gets a set only when a trusted person granted it (board/schemas.ts,
 *            `relay-grant`); every task gets none by default.
 *   vercel   the Vercel project whose development environment a granted set's values are read from, with the
 *            worker's own `vercel login`
 *   cloud    whether a task of this project may ever run in a paid sandbox: `ask` (the default) or `never`
 */
import { JOB_ENV_STRIPPED } from "../work/env.ts";
import { PROFILE_PATH, type StepFiles } from "./index.ts";

export interface ProfileTool {
  name: string;
  /** The command, as it is typed from the repository's root. */
  run: string;
  about: string;
  /** The capability set it cannot work without. */
  needs?: string;
}

export interface CapabilitySet {
  /** Names of environment variables. */
  env: string[];
  /** Hosts the lane's sandbox may reach: `api.example.com`, or `*.example.com` for its subdomains. */
  hosts: string[];
}

export type CloudPolicy = "ask" | "never";

export interface ProjectProfile {
  setup: string[];
  verify: string[];
  tools: ProfileTool[];
  skills: string[];
  sets: Record<string, CapabilitySet>;
  vercel: { project: string; team?: string } | null;
  cloud: CloudPolicy;
  problems: string[];
}

/** Every key the file may hold; `steps` is read by the step loader (steps/index.ts). */
export const PROFILE_KEYS = ["steps", "setup", "verify", "tools", "skills", "sets", "vercel", "cloud"] as const;

export const EMPTY_PROFILE: ProjectProfile = { setup: [], verify: [], tools: [], skills: [], sets: {}, vercel: null, cloud: "ask", problems: [] };

export const SET_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,95}$/;
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** One line a shell runs: no line break, no NUL, within what a prompt and a log can carry. */
const isCommand = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 400 && !/[\n\r\0]/.test(v);
const isPath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 300 && !v.startsWith("/") && !v.split("/").includes("..") && !/[\n\r\0]/.test(v);
const strings = (v: unknown): v is unknown[] => Array.isArray(v);

/**
 * Read the profile from where it is kept (a ref of a clone during a job, the working tree for `relay adopt`).
 * Anything malformed is left out and named in `problems`; nothing malformed is ever half-applied.
 */
export function readProfile(files: StepFiles): ProjectProfile {
  const text = files.read(PROFILE_PATH);
  if (text === undefined) return { ...EMPTY_PROFILE, sets: {} };
  const at = files.label(PROFILE_PATH);
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it must be a JSON object");
    j = parsed as Record<string, unknown>;
  } catch (e) {
    return { ...EMPTY_PROFILE, sets: {}, problems: [`${at} is not usable: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const problems: string[] = [];
  const bad = (what: string): void => void problems.push(`${at}: ${what}`);
  // a key relay does not know is most often a misspelt one, and a misspelt `verify` is a check that silently never runs
  for (const key of Object.keys(j)) if (!(PROFILE_KEYS as readonly string[]).includes(key)) bad(`'${key.slice(0, 40)}' is not a key of the profile (${PROFILE_KEYS.join(", ")}); it is ignored`);
  const commands = (key: "setup" | "verify"): string[] => {
    const v = j[key];
    if (v === undefined) return [];
    if (!strings(v) || !v.every(isCommand)) return bad(`${key} must be a list of one-line commands`), [];
    return v.map((c) => c.trim());
  };

  const sets: Record<string, CapabilitySet> = {};
  if (j.sets !== undefined) {
    if (!j.sets || typeof j.sets !== "object" || Array.isArray(j.sets)) bad("sets must be an object of capability sets by name");
    else {
      for (const [name, raw] of Object.entries(j.sets as Record<string, unknown>)) {
        const s = raw as { env?: unknown; hosts?: unknown } | null;
        const env = s?.env ?? [];
        const hosts = s?.hosts ?? [];
        if (!SET_NAME.test(name)) bad(`'${name}' is not a set name (lowercase letters, digits and dashes)`);
        else if (!s || typeof s !== "object" || !strings(env) || !strings(hosts)) bad(`set '${name}' must have env and hosts lists`);
        else if (!env.every((e): e is string => typeof e === "string" && ENV_NAME.test(e))) bad(`set '${name}': env holds names of environment variables only (A_NAME), never values`);
        else if (env.some((e) => (JOB_ENV_STRIPPED as readonly string[]).includes(e))) bad(`set '${name}' names a credential no job may carry (${env.filter((e) => (JOB_ENV_STRIPPED as readonly string[]).includes(e)).join(", ")})`);
        else if (!hosts.every((h): h is string => typeof h === "string" && HOST.test(h))) bad(`set '${name}': hosts are host names (api.example.com, *.example.com)`);
        else sets[name] = { env: [...new Set(env)], hosts: [...new Set(hosts)] };
      }
    }
  }

  const tools: ProfileTool[] = [];
  if (j.tools !== undefined) {
    if (!strings(j.tools)) bad("tools must be a list");
    else {
      for (const raw of j.tools) {
        const t = raw as { name?: unknown; run?: unknown; about?: unknown; needs?: unknown } | null;
        if (!t || typeof t !== "object" || typeof t.name !== "string" || !SET_NAME.test(t.name) || !isCommand(t.run)) bad("each tool has a name (lowercase letters, digits and dashes) and a one-line run command");
        else if (t.needs !== undefined && (typeof t.needs !== "string" || !sets[t.needs])) bad(`tool '${t.name}' needs the set '${String(t.needs)}', which the profile does not define`);
        else tools.push({ name: t.name, run: t.run.trim(), about: typeof t.about === "string" ? t.about.replace(/\s+/g, " ").trim().slice(0, 300) : "", ...(typeof t.needs === "string" ? { needs: t.needs } : {}) });
      }
    }
  }

  let skills: string[] = [];
  if (j.skills !== undefined) {
    if (!strings(j.skills) || !j.skills.every(isPath)) bad("skills must be a list of paths inside the repository");
    else skills = [...new Set(j.skills)];
  }

  let vercel: ProjectProfile["vercel"] = null;
  if (j.vercel !== undefined) {
    const v = j.vercel as { project?: unknown; team?: unknown } | null;
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
    if (!v || typeof v.project !== "string" || !name.test(v.project) || (v.team !== undefined && (typeof v.team !== "string" || !name.test(v.team)))) bad("vercel must name a project (and optionally a team)");
    else vercel = { project: v.project, ...(typeof v.team === "string" ? { team: v.team } : {}) };
  }

  let cloud: CloudPolicy = "ask";
  if (j.cloud !== undefined) {
    if (j.cloud !== "ask" && j.cloud !== "never") bad("cloud must be ask or never");
    else cloud = j.cloud;
  }

  return { setup: commands("setup"), verify: commands("verify"), tools, skills, sets, vercel, cloud, problems };
}

/** What a granted set adds to a job: the names of the variables to carry and the hosts to allow. A set the profile does not define adds nothing. */
export function grantedAccess(profile: ProjectProfile, granted: readonly string[]): { env: string[]; hosts: string[]; unknown: string[] } {
  const env = new Set<string>();
  const hosts = new Set<string>();
  const unknown: string[] = [];
  for (const name of new Set(granted)) {
    const set = profile.sets[name];
    if (!set) unknown.push(name);
    else {
      for (const e of set.env) env.add(e);
      for (const h of set.hosts) hosts.add(h);
    }
  }
  return { env: [...env], hosts: [...hosts], unknown };
}

/** The Bash patterns a profile's commands add to a lane's allowlist: each command as written, and with arguments after it. */
export function profileToolPatterns(profile: ProjectProfile): string[] {
  const commands = [...profile.setup, ...profile.verify, ...profile.tools.map((t) => t.run)];
  return [...new Set(commands.map((c) => `Bash(${c}*)`))];
}
