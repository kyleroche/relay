import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSteps } from "../src/commands/steps.ts";

let dir: string;
const run = (...args: string[]) => {
  const p = new Command().exitOverride();
  registerSteps(p);
  return p.parseAsync(["node", "relay", "steps", ...args, "--cwd", dir]);
};
const profile = () => JSON.parse(readFileSync(join(dir, ".relay", "project.json"), "utf8")) as { steps: string[]; cloud?: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-steps-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("relay steps", () => {
  it("add and rm keep the project's list in order and leave the rest of the profile alone", async () => {
    execFileSync("mkdir", ["-p", join(dir, ".relay")]);
    writeFileSync(join(dir, ".relay", "project.json"), JSON.stringify({ cloud: "ask" }));
    await run("add", "remove-yap");
    await run("add", "eval");
    await run("add", "eval");
    expect(profile()).toEqual({ cloud: "ask", steps: ["remove-yap", "eval"] });
    await run("rm", "remove-yap");
    expect(profile().steps).toEqual(["eval"]);
  });

  it("add refuses a step that does not exist, one that only answers another, and one that is a task of its own", async () => {
    await expect(run("add", "lint-poetry")).rejects.toThrow(/no step named 'lint-poetry'/);
    await expect(run("add", "eval-respond")).rejects.toThrow(/answers another step's findings/);
    await expect(run("add", "cleanup")).rejects.toThrow(/relay steps run cleanup/);
    expect(existsSync(join(dir, ".relay", "project.json"))).toBe(false);
  });

  it("eject copies relay's step into the repository, where it becomes the copy that runs", async () => {
    await run("eject", "eval");
    const copy = join(dir, ".relay", "steps", "eval.md");
    expect(readFileSync(copy, "utf8")).toContain("name: eval");
    await expect(run("eject", "eval")).rejects.toThrow(/is already the copy that runs/);
  });

  it("run takes only a step that is a task of its own", async () => {
    await expect(run("run", "eval", "--project", "demo", "--repo", "acme/demo")).rejects.toThrow(/only a step whose when is task can be run by itself/);
  });
});
