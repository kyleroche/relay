/**
 * `relay handoff` against a real git repository with a bare remote and an in-memory board: what `--push` sends, and
 * that the checkout it sends from is left exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { board } from "@relay/core";
import { BODY_HELP, commitWorkInProgress, pushWorkInProgress, registerHandoff } from "../src/commands/handoff.ts";

let tmp: string;
let bare: string;
let repo: string;
const sh = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const put = (path: string, text: string): void => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};
/** Everything a handoff must leave alone: what git reports, the index file's bytes, where HEAD is and which branches exist. */
const checkout = () => ({
  status: sh(repo, ["status", "--porcelain", "--untracked-files=all", "--ignored"]),
  index: createHash("sha256").update(readFileSync(join(repo, ".git", "index"))).digest("hex"),
  head: sh(repo, ["rev-parse", "HEAD"]),
  branch: sh(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
  // local branches and tags; the push itself leaves one remote-tracking ref for the branch it made, as any push does
  refs: sh(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]),
  stash: sh(repo, ["stash", "list"]),
});

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-handoff-test-")));
  bare = join(tmp, "origin.git");
  repo = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, ["config", "user.name", "Sam"]);
  sh(repo, ["config", "user.email", "sam@example.com"]);
  put(".gitignore", "secret.env\nnode_modules/\n");
  put("src/app.js", "export const answer = 41;\n");
  put("src/old.js", "export const old = true;\n");
  put("README.md", "# demo\n");
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-q", "-m", "init"]);
  sh(repo, ["remote", "add", "origin", `file://${bare}`]);
  sh(repo, ["push", "-q", "-u", "origin", "main"]);
  // work in progress: an edit that is staged, one that is not, a deletion, a new file, and two things git ignores
  put("src/app.js", "export const answer = 42;\n");
  sh(repo, ["add", "src/app.js"]);
  put("README.md", "# demo\n\nHalf-written notes.\n");
  rmSync(join(repo, "src", "old.js"));
  put("src/new.js", "export const fresh = true;\n");
  put("secret.env", "TOKEN=do-not-send\n");
  put("node_modules/dep/index.js", "module.exports = 1;\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("pushing work in progress", () => {
  it("leaves the working tree, the index and the branch exactly as they were", () => {
    const before = checkout();
    const sent = pushWorkInProgress(repo, "Finish the answer");
    expect(checkout()).toEqual(before);
    expect(sent.head).toBe(before.head);
    expect(sent.branch).toBe(`relay/handoff/${sent.sha.slice(0, 8)}`);
    expect(readFileSync(join(repo, "secret.env"), "utf8")).toBe("TOKEN=do-not-send\n");
    expect(sh(repo, ["for-each-ref", "--format=%(refname)", "refs/remotes"]).split("\n")).toEqual(["refs/remotes/origin/main", `refs/remotes/origin/${sent.branch}`]);
  });

  it("sends the uncommitted change as one commit on top of HEAD: edits, a deletion and an untracked file", () => {
    const sent = pushWorkInProgress(repo, "Finish the answer");
    expect(sh(bare, ["rev-parse", sent.branch])).toBe(sent.sha);
    expect(sh(bare, ["rev-parse", `${sent.branch}^`])).toBe(sh(repo, ["rev-parse", "HEAD"]));
    expect(sh(bare, ["show", `${sent.branch}:src/app.js`])).toBe("export const answer = 42;");
    expect(sh(bare, ["show", `${sent.branch}:README.md`])).toContain("Half-written notes.");
    expect(sh(bare, ["show", `${sent.branch}:src/new.js`])).toBe("export const fresh = true;");
    expect(sh(bare, ["ls-tree", "-r", "--name-only", sent.branch]).split("\n")).toEqual([".gitignore", "README.md", "src/app.js", "src/new.js"]);
    expect(sent.files).toEqual(["README.md", "src/app.js", "src/new.js", "src/old.js"]);
    expect(sh(bare, ["log", "-1", "--format=%an|%s", sent.branch])).toBe("Sam|relay handoff: Finish the answer");
    // main on the remote is where it was
    expect(sh(bare, ["rev-parse", "main"])).toBe(sh(repo, ["rev-parse", "HEAD"]));
  });

  it("sends nothing git ignores", () => {
    const sent = pushWorkInProgress(repo, "Finish the answer");
    const tree = sh(bare, ["ls-tree", "-r", "--name-only", sent.branch]);
    expect(tree).not.toContain("secret.env");
    expect(tree).not.toContain("node_modules");
    expect(() => sh(bare, ["grep", "do-not-send", sent.sha])).toThrow(); // git grep exits 1: no match anywhere in the commit
  });

  it("keeps a tracked file that an ignore rule matches, and points the branch at HEAD when nothing is uncommitted", () => {
    sh(repo, ["add", "-A"]);
    sh(repo, ["add", "-f", "secret.env"]);
    sh(repo, ["commit", "-q", "-m", "wip, with a file someone chose to track"]);
    put("secret.env", "TOKEN=tracked-and-edited\n");
    const edited = commitWorkInProgress(repo, "m");
    expect(sh(repo, ["show", `${edited.sha}:secret.env`])).toBe("TOKEN=tracked-and-edited");
    sh(repo, ["checkout", "-q", "--", "secret.env"]);
    const clean = pushWorkInProgress(repo, "Nothing new");
    expect(clean.sha).toBe(sh(repo, ["rev-parse", "HEAD"]));
    expect(clean.files).toEqual([]);
    expect(sh(bare, ["rev-parse", clean.branch])).toBe(clean.sha);
  });
});

describe("relay handoff", () => {
  async function rig() {
    const b = await board.memoryBoard();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
    const run = (...args: string[]) => {
      const p = new Command().exitOverride();
      registerHandoff(p, { openBoard: () => b });
      return p.parseAsync(["node", "relay", "handoff", ...args, "--project", "demo", "--cwd", repo]);
    };
    writeFileSync(join(tmp, "brief.md"), "Goal: `answer` is 42 everywhere.\nFiles: src/app.js, src/new.js.\nOut of scope: the README.\nDone when: `node --test` passes.\n");
    return { b, out, err, run, brief: join(tmp, "brief.md") };
  }

  it("refuses a handoff with no brief, says what one holds, and pushes nothing", async () => {
    const r = await rig();
    await expect(r.run("--title", "Finish the answer", "--lane", "claude", "--push")).rejects.toThrow(BODY_HELP);
    writeFileSync(join(tmp, "empty.md"), "  \n");
    await expect(r.run("--title", "Finish the answer", "--lane", "claude", "--body-file", join(tmp, "empty.md"), "--push")).rejects.toThrow(/the command that proves it is done/);
    expect(sh(bare, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
    expect(await board.listTasks(r.b, { state: "all" })).toEqual([]);
  });

  it("with --push opens the task on the pushed branch and prints its ID", async () => {
    const r = await rig();
    const before = checkout();
    await r.run("--title", "Finish the answer", "--lane", "claude", "--model", "fable", "--body-file", r.brief, "--push");
    expect(checkout()).toEqual(before);
    const [task] = await board.listTasks(r.b, { state: "all" });
    expect(r.out).toEqual([task!.id]);
    expect(task).toMatchObject({ title: "Finish the answer", lane: "claude", model: "fable", project: "demo", state: "queued" });
    expect(task!.base).toMatch(/^relay\/handoff\/[0-9a-f]{8}$/);
    expect(sh(bare, ["show", `${task!.base}:src/new.js`])).toBe("export const fresh = true;");
    const text = (await board.getTask(r.b, task!.id)).task.body;
    expect(text).toContain("Done when: `node --test` passes.");
    expect(text).toContain(`Work in progress is on the branch \`${task!.base}\``);
    expect(r.err.join("\n")).toContain("this checkout is unchanged");
  });

  it("without --push starts from the default branch and says the uncommitted work was not sent", async () => {
    const r = await rig();
    await r.run("--title", "Finish the answer", "--lane", "claude", "--body-file", r.brief);
    const [task] = await board.listTasks(r.b, { state: "all" });
    expect(task!.base).toBeNull();
    expect(sh(bare, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
    expect(r.err.join("\n")).toMatch(/starts from the repository's default branch; the uncommitted work here was NOT sent \(4 files: /);
    expect((await board.getTask(r.b, task!.id)).task.body).not.toContain("Work in progress");
  });

  it("refuses a lane nobody serves before anything is pushed", async () => {
    const r = await rig();
    await r.run("--title", "Finish the answer", "--lane", "render-farm", "--body-file", r.brief, "--push");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(await board.listTasks(r.b, { state: "all" })).toEqual([]);
    expect(r.err.join("\n")).toContain("no worker serves lane 'render-farm'");
    expect(sh(bare, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
  });
});
