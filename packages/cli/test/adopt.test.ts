/**
 * `relay adopt` as a command: a real directory laid out the way Claude Code lays out `~/.claude/projects`, a real
 * repository, and the plan printed with nothing written anywhere. Every note here is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let registerAdopt: typeof import("../src/commands/adopt.ts").registerAdopt;
let core: typeof import("@relay/core");
let tmp: string;
let repo: string;
let projects: string;
let home: string;

const put = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const note = (type: string, description: string, body: string): string => `---\nname: n\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
const bash = (cwd: string, command: string): string => JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-adopt-cli-")));
  repo = join(tmp, "shop");
  projects = join(tmp, "claude", "projects");
  home = join(tmp, "harness");
  process.env.RELAY_HOME = home;
  core = await import("@relay/core");
  ({ registerAdopt } = await import("../src/commands/adopt.ts"));
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/shop.git"], { cwd: repo });
  put(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  put(join(repo, "package-lock.json"), "{}");
  put(join(repo, "scripts", "sync.mjs"), "// Sync the catalogue from the supplier feed.\nfetch('https://feed.supplier.example/v1', { headers: { key: process.env.SUPPLIER_KEY } });\n");
  const dir = join(projects, core.claudeProjectDirName(repo));
  put(join(dir, "memory", "MEMORY.md"), "- [Catalogue layout](catalogue.md) — where things are\n");
  put(join(dir, "memory", "catalogue.md"), note("project", "How the catalogue tables fit together", "Products own variants; variants own prices."));
  put(join(dir, "memory", "small-diffs.md"), note("feedback", "Keep pull requests under 300 lines", "Small diffs only.\n\n**Why:** reviews happen on a phone."));
  put(join(dir, "memory", "with-key.md"), note("reference", "Supplier login", "password: Sup3rS3cretValue1234567890"));
  put(join(dir, "s1.jsonl"), [bash(repo, "node scripts/sync.mjs --since 2026-01-01"), bash(repo, "node scripts/sync.mjs"), bash(repo, "npm test"), bash(repo, "npm test")].join("\n"));
  put(join(`${dir}--claude-worktrees-try-it`, "s2.jsonl"), bash(join(repo, ".claude", "worktrees", "try-it"), "node scripts/sync.mjs"));
});
afterAll(() => {
  delete process.env.RELAY_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

async function adopt(...args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
  const error = vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
  try {
    const p = new Command().exitOverride();
    registerAdopt(p);
    await p.parseAsync(["node", "relay", "adopt", repo, "--claude-projects", projects, ...args]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("relay adopt", () => {
  it("prints the plan grouped by what would happen, with counts", async () => {
    const { out, err } = await adopt();
    expect(out).toContain(`${repo} (project shop)`);
    expect(out).toMatch(/Claude Code: 2 project directories under .* \(1 of them worktrees\), 2 transcripts \(.*\), 3 memory notes/);
    expect(out).toContain("Repository files (2 to write)");
    expect(out).toMatch(/write\s+docs\/context\/catalogue\.md\s+How the catalogue tables fit together/);
    expect(out).toContain("Decisions (1 to record)");
    expect(out).toMatch(/record\s+small-diffs\.md\s+Keep pull requests under 300 lines\. Why: reviews happen on a phone\./);
    expect(out).toContain("Skipped (1)");
    expect(out).toContain("with-key.md  looks like it holds a secret (assigned secret)");
    expect(out).not.toContain("Sup3rS3cret");
    expect(out).toContain("Profile draft (.relay/project.json): from 5 Bash calls in 2 transcripts");
    expect(out).toMatch(/\s3\s+node scripts\/sync\.mjs\s+\(2 sessions\)/);
    expect(out).toContain('"run": "node scripts/sync.mjs"');
    expect(out).toContain('"SUPPLIER_KEY"');
    expect(out).toContain('"feed.supplier.example"');
    expect(err).toContain("nothing was written or recorded");
  });

  it("gives a machine the whole plan, the files' contents included", async () => {
    const plan = JSON.parse((await adopt("--json")).out) as import("@relay/core").AdoptPlan;
    expect(plan.project).toBe("shop");
    expect(plan.files.map((f) => f.path)).toEqual([".relay/project.json", "docs/context/README.md", "docs/context/catalogue.md"]);
    expect(plan.files[2]!.content).toContain("# Catalogue layout\n\n> How the catalogue tables fit together\n\nProducts own variants; variants own prices.");
    expect(JSON.parse(plan.files[0]!.content)).toEqual({
      setup: ["npm ci"],
      verify: ["npm test"],
      tools: [{ name: "sync", run: "node scripts/sync.mjs", about: "Sync the catalogue from the supplier feed.", needs: "supplier" }],
      sets: { supplier: { env: ["SUPPLIER_KEY"], hosts: ["feed.supplier.example"] } },
    });
    expect(plan.profile.problems).toEqual([]);
    expect(plan.decisions).toMatchObject([{ file: "small-diffs.md", action: "record", sourceRef: "claude-memory:small-diffs.md" }]);
  });

  it("is a dry run: the repository, relay's home and Claude Code's files are as they were", async () => {
    await adopt();
    await adopt("--json", "--no-transcripts");
    expect(readdirSync(repo).sort()).toEqual([".git", "package-lock.json", "package.json", "scripts"]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().split("\n").sort()).toEqual(["?? package-lock.json", "?? package.json", "?? scripts/"]);
    expect(existsSync(core.adoptStatePath())).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(join(projects, core.claudeProjectDirName(repo), "memory")).sort()).toEqual(["MEMORY.md", "catalogue.md", "small-diffs.md", "with-key.md"]);
  });

  it("without the transcripts still drafts what the repository says about itself", async () => {
    const plan = JSON.parse((await adopt("--json", "--no-transcripts")).out) as import("@relay/core").AdoptPlan;
    expect(plan.commands.bashCalls).toBe(0);
    expect(JSON.parse(plan.files[0]!.content)).toEqual({ setup: ["npm ci"] });
  });
});
