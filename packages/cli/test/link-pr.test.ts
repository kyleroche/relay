/**
 * `relay link` as the one command that adds a repository: against a bare repository as origin, with a home that
 * holds Claude Code memory for the checkout, it proposes every repository file as one commit on `relay/link` and
 * opens one pull request, without writing to the checkout. The pull request host is injected; nothing leaves the
 * machine and no model runs (--no-digest).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

type Core = typeof import("@relay/core");
let core: Core;
let registerLink: typeof import("../src/commands/link.ts").registerLink;
let tmp: string;
let repoDir: string;
let bare: string;

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const created: Array<{ repo: string; base: string; head: string; title: string; body: string }> = [];
let open: { number: number; url: string } | undefined;
const comments: string[] = [];
const host = {
  comment: async (_repo: string, _pr: number, body: string) => (comments.push(body), "c1"),
  findPr: async () => open,
  createPr: async (repo: string, i: { base: string; head: string; title: string; body: string }) => {
    created.push({ repo, ...i });
    open = { number: 7, url: `https://github.com/${repo}/pull/7` };
    return open;
  },
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-link-pr-")));
  // the origin's path ends in acme/demo.git, so the checkout's repository reads as acme/demo
  bare = join(tmp, "remote", "acme", "demo.git");
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  repoDir = join(tmp, "demo");
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# demo\n");
  writeFileSync(join(repoDir, "AGENTS.md"), "# AGENTS.md\n\nUse two spaces.\n");
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }, null, 2) + "\n");
  writeFileSync(join(repoDir, ".github", "workflows", "relay-caller.yml"), "# relay caller: installed into a repo by `relay link` as .github/workflows/relay-caller.yml.\nname: relay\n");
  writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\njobs: {}\n");
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["remote", "add", "origin", bare]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "first"]);
  git(repoDir, ["push", "-q", "origin", "main"]);

  process.env.RELAY_HOME = join(tmp, "harness");
  process.env.RELAY_USER_HOME = join(tmp, "userhome");
  core = await import("@relay/core");
  const memory = join(core.claudeProjectsRoot(), core.claudeProjectDirName(repoDir), "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "- [Shipping rates](shipping-rates.md) — where they come from\n- [No force pushes](no-force-push.md) — never\n");
  writeFileSync(join(memory, "shipping-rates.md"), "---\nname: shipping-rates\ndescription: Shipping rates come from the carrier table, refreshed nightly\nmetadata:\n  type: project\n---\n\nThe table is rebuilt by the nightly job.\n");
  writeFileSync(join(memory, "no-force-push.md"), "---\nname: no-force-push\ndescription: Never force-push the main branch\nmetadata:\n  type: feedback\n---\n\n**Why:** a deploy reads it.\n");
  ({ registerLink } = await import("../src/commands/link.ts"));
});
afterAll(() => {
  delete process.env.RELAY_USER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

/** What the person answers when link asks about the notes; undefined = nobody is there to ask. */
let answer: boolean | undefined;
const asked: string[] = [];

async function link(...extra: string[]): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const program = new Command().exitOverride();
    registerLink(program, { host, confirm: async (q) => (asked.push(q), answer ?? false) });
    await program.parseAsync(["link", "--cwd", repoDir, "--no-labels", "--no-digest", ...extra], { from: "user" });
  } finally {
    console.error = orig;
  }
  return lines.map((l) => l.replace(/^\[relay\] /, ""));
}

const branchTip = (): string | undefined => git(bare, ["for-each-ref", "--format=%(objectname)", "refs/heads/relay/link"]) || undefined;
const onBranch = (path: string): string => git(bare, ["show", `relay/link:${path}`]);
const branchFiles = (): string[] => git(bare, ["ls-tree", "-r", "--name-only", "relay/link"]).split("\n");

describe("relay link, as one pull request", () => {
  it("asks before anything from Claude Code's memory leaves the machine, and a no leaves all of it out", async () => {
    answer = false;
    const lines = await link();
    expect(asked).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("adopt:   "))).toEqual([
      "adopt:   docs/context/shipping-rates.md  Shipping rates come from the carrier table, refreshed nightly",
      "adopt:   preference  Never force-push the main branch. Why: a deploy reads it.",
    ]);
    // the pull request is opened with relay's own files only; no note, no preference in relay.md, no decision in memory
    expect(branchFiles().filter((f) => f.startsWith("docs/"))).toEqual([]);
    expect(onBranch("relay.md")).not.toContain("force-push");
    const h = await core.openHarness();
    try {
      expect(await core.repo.listDecisions(h.db, "demo", { current: true, limit: 10 })).toEqual([]);
    } finally {
      await h.close();
    }
    expect(created).toHaveLength(1);
  });

  it("with a yes, adds the notes to the same pull request on top of what is there, and leaves the checkout alone", async () => {
    answer = true;
    const before = branchTip()!;
    const lines = await link();
    expect(lines[0]).toBe("repo: relay's files go into the open pull request https://github.com/acme/demo/pull/7, on top of what is on relay/link now; this checkout is left as it is");

    // the checkout: nothing written, nothing staged, still on main
    expect(git(repoDir, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repoDir, "relay.md"))).toBe(false);
    expect(existsSync(join(repoDir, ".relay"))).toBe(false);
    expect(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

    // the branch: the first proposal on top of main, this one on top of it, and the old caller workflow gone
    const tip = branchTip()!;
    expect(git(bare, ["rev-parse", `${tip}^`])).toBe(before);
    expect(git(bare, ["rev-parse", `${before}^`])).toBe(git(bare, ["rev-parse", "main"]));
    expect(branchFiles()).toEqual([".github/workflows/ci.yml", ".relay/rules.json", "AGENTS.md", "README.md", "docs/context/README.md", "docs/context/shipping-rates.md", "package.json", "relay.md"]);
    const agents = onBranch("AGENTS.md");
    expect(agents.startsWith("# AGENTS.md\n\nUse two spaces.\n")).toBe(true);
    expect(agents).toContain("<!-- relay:begin -->");
    expect(JSON.parse(onBranch(".relay/rules.json"))).toMatchObject({ project: "demo", repo: "acme/demo" });
    expect(onBranch("docs/context/shipping-rates.md")).toContain("The table is rebuilt by the nightly job.");
    expect(onBranch("docs/context/README.md")).toContain("[Shipping rates](shipping-rates.md): Shipping rates come from the carrier table, refreshed nightly");
    // the preference went to memory before relay.md was rendered from it
    expect(onBranch("relay.md")).toContain("Never force-push the main branch");

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ repo: "acme/demo", base: "main", head: "relay/link", title: "Link this repository to relay" });
    expect(created[0]!.body).toContain("removed: `.github/workflows/relay-caller.yml`");
    // what this run added is said on the pull request, where the reviewer reads it
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("`docs/context/`: 1 note");
    expect(comments[0]).toContain("**Read them before merging**");
    expect(comments[0]).toContain("1 standing preference");
    expect(lines.at(-1)).toBe("left: merge https://github.com/acme/demo/pull/7 (read the notes and the profile in it first); until then workers see none of these files");

    const h = await core.openHarness();
    try {
      const decisions = await core.repo.listDecisions(h.db, "demo", { current: true, limit: 10 });
      expect(decisions.map((d) => d.text)).toEqual(["Never force-push the main branch. Why: a deploy reads it."]);
    } finally {
      await h.close();
    }
  });

  it("keeps a reviewer's commits: a later run reads the branch as they left it and only adds to it", async () => {
    // the reviewer takes the pull request's invitation and edits it: a profile of their own, and a note corrected by hand
    const review = join(tmp, "review");
    git(tmp, ["clone", "-q", "--branch", "relay/link", bare, review]);
    git(review, ["config", "user.name", "Reviewer"]);
    git(review, ["config", "user.email", "reviewer@example.com"]);
    mkdirSync(join(review, ".relay"), { recursive: true });
    writeFileSync(join(review, ".relay", "project.json"), JSON.stringify({ verify: ["npm test"], cloud: "never" }, null, 2) + "\n");
    git(review, ["add", "-A"]);
    git(review, ["commit", "-q", "-m", "Never run this in the cloud"]);
    git(review, ["push", "-q", "origin", "relay/link"]);
    const theirs = branchTip()!;

    // the note changes on the machine that linked, and link runs again
    const memory = join(core.claudeProjectsRoot(), core.claudeProjectDirName(repoDir), "memory");
    writeFileSync(join(memory, "shipping-rates.md"), "---\nname: shipping-rates\ndescription: Shipping rates come from the carrier table, refreshed hourly\nmetadata:\n  type: project\n---\n\nThe table is rebuilt every hour.\n");
    answer = true;
    await link();
    const tip = branchTip()!;
    expect(git(bare, ["rev-parse", `${tip}^`])).toBe(theirs);
    expect(JSON.parse(onBranch(".relay/project.json"))).toEqual({ verify: ["npm test"], cloud: "never" });
    expect(onBranch("docs/context/shipping-rates.md")).toContain("The table is rebuilt every hour.");
    expect(created).toHaveLength(1);
  });

  it("a second run pushes nothing and opens nothing; once merged, there is nothing to propose", async () => {
    const tip = branchTip();
    asked.length = 0;
    const again = await link();
    expect(branchTip()).toBe(tip);
    expect(created).toHaveLength(1);
    // nothing new from memory, so nothing to ask
    expect(asked).toEqual([]);
    expect(again.find((l) => l.startsWith("pull request:"))).toMatch(/already holds every file; nothing added$/);
    expect(again.find((l) => l.startsWith("adopt:"))).toContain("0 preferences recorded as decisions (1 already recorded)");

    // merged: main is now the proposal
    git(bare, ["update-ref", "refs/heads/main", tip!]);
    open = undefined;
    const merged = await link();
    expect(merged).toContain("pull request: none needed, main has every file");
    expect(created).toHaveLength(1);
    expect(merged.at(-1)).toMatch(/^done: demo is linked/);
    expect(git(repoDir, ["status", "--porcelain"])).toBe("");
  });

  it("after a merge, a note that changes starts a new pull request from the default branch, over the branch the merged one left", async () => {
    const memory = join(core.claudeProjectsRoot(), core.claudeProjectDirName(repoDir), "memory");
    writeFileSync(join(memory, "shipping-rates.md"), "---\nname: shipping-rates\ndescription: Shipping rates come from the carrier table, refreshed daily\nmetadata:\n  type: project\n---\n\nThe table is rebuilt every day.\n");
    answer = true;
    const lines = await link();
    const tip = branchTip()!;
    expect(git(bare, ["rev-parse", `${tip}^`])).toBe(git(bare, ["rev-parse", "main"]));
    expect(onBranch("docs/context/shipping-rates.md")).toContain("The table is rebuilt every day.");
    expect(created).toHaveLength(2);
    expect(lines.find((l) => l.startsWith("pull request:"))).toContain("docs/context/README.md, docs/context/shipping-rates.md");
  });
});
