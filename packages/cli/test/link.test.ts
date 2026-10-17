/**
 * The real `relay link` flow against a throwaway git repo, with RELAY_FAKE_LANES=1 so the Claude lane returns canned
 * JSON instead of spawning `claude` (no network, no login). --no-labels keeps gh out (the caller workflows are opt-in since --workflows).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

type Core = typeof import("@relay/core");
let core: Core;
let registerLink: typeof import("../src/commands/link.ts").registerLink;
let tmp: string;
let home: string;
let repoDir: string;

const git = (args: string[]): void => {
  execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
};

beforeAll(async () => {
  // realpath: git reports the toplevel with symlinks resolved (/private/var on macOS)
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-link-")));
  home = join(tmp, "harness");
  repoDir = join(tmp, "demo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# demo\n\nA small demo project for the relay link test.\n");
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }, null, 2) + "\n");
  writeFileSync(join(repoDir, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(repoDir, "src", "util.ts"), "export const twice = (n: number): number => n * 2;\n");
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  // RELAY_HOME is read when @relay/core loads, so both go into the environment before the first import
  process.env.RELAY_HOME = home;
  process.env.RELAY_FAKE_LANES = "1";
  core = await import("@relay/core");
  ({ registerLink } = await import("../src/commands/link.ts"));
});
afterAll(() => {
  delete process.env.RELAY_FAKE_LANES;
  rmSync(tmp, { recursive: true, force: true });
});

async function link(...extra: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerLink(program);
  await program.parseAsync(["link", "--cwd", repoDir, "--no-labels", ...extra], { from: "user" });
}

async function inspect() {
  const h = await core.openHarness();
  try {
    const project = await core.repo.getProject(h.db, "demo");
    const digests = await core.repo.listFileDigests(h.db, "demo");
    const calls = (await core.repo.listEvents(h.db, { project: "demo", kind: "step.usage", limit: 1000 })).length;
    // newest first; payload.calls is the per-run count the cost line prints
    const linked = (await core.repo.listEvents(h.db, { project: "demo", kind: "project.linked", limit: 1000 })).map((e) => e.payload.calls as number);
    return { project, digests, calls, linked };
  } finally {
    await h.close();
  }
}

describe("relay link", () => {
  it("registers, digests, summarizes and writes relay.md in one run, and a second run makes no model calls", async () => {
    await link();
    const first = await inspect();
    expect(first.project?.repo).toBe("acme/demo");
    expect(first.project?.path).toBe(repoDir);
    expect(first.linked).toEqual([2]);
    // AGENTS.md was created by the owned-section step before hashing, so it is digested in the same run; relay.md never is
    expect(first.digests.map((d) => d.path)).toEqual(["AGENTS.md", "README.md", "package.json", "src/index.ts", "src/util.ts"]);
    for (const d of first.digests) {
      expect(d.summary).toContain(`Canned digest of ${d.path}`);
      expect(d.summary_sha).toBe(d.sha256);
    }
    expect(first.project?.summary).toContain("## Purpose");
    expect(core.validateSummary(first.project!.summary!)).toEqual([]);
    expect(first.calls).toBe(2); // one digest batch (5 files, 8 per batch) and one summary

    const rules = readFileSync(join(repoDir, "relay.md"), "utf8");
    expect(rules).toContain("# relay rules for demo");
    expect(rules).toContain("## Project summary");
    expect(rules).toContain("## Purpose");
    expect(rules).toContain("## Gotchas");
    expect(readFileSync(join(repoDir, "AGENTS.md"), "utf8")).toContain("<!-- relay:begin -->");
    expect(JSON.parse(readFileSync(join(repoDir, ".relay", "rules.json"), "utf8"))).toMatchObject({ project: "demo", repo: "acme/demo" });
    expect(existsSync(join(repoDir, ".github"))).toBe(false);

    await link();
    const second = await inspect();
    expect(second.calls).toBe(first.calls);
    expect(second.linked).toEqual([0, 2]);
    expect(second.project?.summary).toBe(first.project?.summary);
    expect(readFileSync(join(repoDir, "relay.md"), "utf8")).toBe(rules);
  });

  it("re-digests only a changed file and rewrites the summary; --refresh rewrites the summary; --no-digest calls nothing", async () => {
    const before = await inspect();
    writeFileSync(join(repoDir, "src", "util.ts"), "export const thrice = (n: number): number => n * 3;\n");
    await link();
    const changed = await inspect();
    expect(changed.calls).toBe(before.calls + 2); // one digest batch for the one stale file, then the summary
    const util = changed.digests.find((d) => d.path === "src/util.ts")!;
    expect(util.summary_sha).toBe(util.sha256);
    expect(util.sha256).not.toBe(before.digests.find((d) => d.path === "src/util.ts")!.sha256);
    expect(changed.digests.filter((d) => d.path !== "src/util.ts").map((d) => d.summarized_at)).toEqual(before.digests.filter((d) => d.path !== "src/util.ts").map((d) => d.summarized_at));

    await link("--refresh");
    expect((await inspect()).calls).toBe(before.calls + 3);

    await link("--no-digest");
    const last = await inspect();
    expect(last.calls).toBe(before.calls + 3);
    expect(last.linked.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it("validates summaries by length and headings", () => {
    const ok = `## Purpose\n\n${"word ".repeat(40)}\n## Stack & layout\n\n${"word ".repeat(40)}\n## Commands\n\nunknown ${"word ".repeat(30)}\n## Conventions and hard rules\n\n${"word ".repeat(30)}\n## Gotchas\n\n${"word ".repeat(20)}`;
    expect(core.validateSummary(ok)).toEqual([]);
    expect(core.validateSummary("I'll check the memory files and get back to you.")).toEqual(["only 10 words (need at least 150)", "missing headings: Purpose, Stack and layout, Commands, Conventions, Gotchas"]);
    expect(core.validateSummary(`## Purpose\n${"word ".repeat(798)}`)).toEqual(["800 words (at most 700)", "missing headings: Stack and layout, Commands, Conventions, Gotchas"]);
  });
});
