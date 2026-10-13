import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { sha256, type Log, noopLog } from "../util.ts";
import { isOfficial } from "./html.ts";

/** agentskills.io discovery format (schemas.agentskills.io/discovery/0.2.0). */
interface WellKnownIndex {
  skills: Array<{ name: string; type: string; description?: string; url: string; digest?: string }>;
}

export interface InstalledSkill {
  name: string;
  version: string;
  installPath: string;
  sha256: string;
  sourceUrl: string;
  skillMd: string;
  description: string;
}

function dirSha(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return sha256(files.map((f) => f.slice(dir.length) + ":" + sha256(readFileSync(f))).join("\n"));
}

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = /^\s*([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2]) out[kv[1]!] = kv[2].trim();
  }
  return out;
}

/**
 * Install a provider-published skill from its well-known index into skillsDir/<provider>/<model>/<name>.
 * Verifies the archive against the index digest. Only allowlisted hosts are contacted.
 */
export async function installWellKnownSkill(args: {
  source: string;
  name: string;
  provider: string;
  modelId: string;
  skillsDir: string;
  docDomains: string[];
  log?: Log;
}): Promise<InstalledSkill> {
  const log = args.log ?? noopLog;
  const base = args.source.endsWith("/") ? args.source : args.source + "/";
  const indexUrl = base + ".well-known/agent-skills/index.json";
  if (!isOfficial(indexUrl, args.docDomains)) throw new Error(`skill source is not an allowlisted host: ${indexUrl}`);
  const idx = (await (await fetch(indexUrl)).json()) as WellKnownIndex;
  const entry = idx.skills.find((s) => s.name === args.name);
  if (!entry) throw new Error(`skill ${args.name} not in ${indexUrl}`);
  if (entry.type !== "archive") throw new Error(`unsupported skill type ${entry.type} for ${args.name}`);
  if (!isOfficial(entry.url, args.docDomains)) throw new Error(`skill archive is not on an allowlisted host: ${entry.url}`);

  const buf = Buffer.from(await (await fetch(entry.url)).arrayBuffer());
  const digest = sha256(buf);
  const want = entry.digest?.replace(/^sha256:/, "");
  if (want && want !== digest) throw new Error(`digest mismatch for ${args.name}: want ${want} got ${digest}`);
  log(`skill ${args.name}: archive ${buf.length} bytes, sha256 ok`);

  const tmp = join(tmpdir(), `relay-skill-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const zip = join(tmp, "skill.zip");
  writeFileSync(zip, buf);
  execFileSync("unzip", ["-o", "-q", zip, "-d", join(tmp, "x")]);
  // the archive may contain the skill folder at root or nested one level
  let root = join(tmp, "x");
  if (!existsSync(join(root, "SKILL.md"))) {
    const sub = readdirSync(root).find((e) => existsSync(join(root, e, "SKILL.md")));
    if (!sub) throw new Error(`no SKILL.md in archive for ${args.name}`);
    root = join(root, sub);
  }
  const dest = join(args.skillsDir, args.provider, args.modelId.replace("/", "__"), args.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  execFileSync("cp", ["-R", root + "/.", dest]);
  rmSync(tmp, { recursive: true, force: true });

  const skillMd = readFileSync(join(dest, "SKILL.md"), "utf8");
  const fm = frontmatter(skillMd);
  const version = fm["skill_version"] ?? fm["version"] ?? (entry.url.match(/\/(\d+\.\d+\.\d+)\//)?.[1] ?? "0");
  return { name: args.name, version, installPath: dest, sha256: dirSha(dest), sourceUrl: entry.url, skillMd, description: fm["description"] ?? entry.description ?? "" };
}
