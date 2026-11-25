/**
 * `relay adopt [path]`: look at what Claude Code knows about a repository on this machine and print what adopting it
 * would do: the notes that would become files under docs/context, the ones that would become decisions, what would
 * be skipped and why, and a first `.relay/project.json` drawn from the commands that were run. A dry run: it writes
 * nothing and records nothing. `relay link` is what adopts, with the same plan (`planAdoption` and `applyAdoption`
 * in @relay/core).
 */
import type { Command } from "commander";
import { resolve } from "node:path";
import { claudeProjectsRoot, planAdoption, readAdoptState, renderAdoptPlan } from "@relay/core";
import { git, log, resolveProject } from "./_common.ts";

/** The other checkouts of the repository at `root`, as git lists them. */
export function worktreesOf(root: string): string[] {
  const out = git(root, ["worktree", "list", "--porcelain"]) ?? "";
  return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length).trim()).filter((p) => p && p !== root);
}

export function registerAdopt(program: Command): void {
  program
    .command("adopt")
    .argument("[path]", "the repository (default: the one this directory is in)")
    .option("--project <slug>", "project slug (default: the linked project of the repository)")
    .option("--claude-projects <dir>", "where Claude Code keeps its per-project directories (default: ~/.claude/projects)")
    .option("--no-transcripts", "do not read the transcripts: no command counts, and a profile draft from the repository's own files only")
    .option("--json", "the whole plan as JSON, the contents of the files included")
    .description("Show what adopting this repository's Claude Code context would do: notes to docs/context, standing preferences to relay's memory, a profile draft from the commands that were run. Writes nothing; relay link adopts")
    .action(async (path: string | undefined, o: { project?: string; claudeProjects?: string; transcripts: boolean; json?: boolean }) => {
      const ref = resolveProject({ cwd: resolve(path ?? "."), ...(o.project ? { project: o.project } : {}) });
      const plan = await planAdoption({
        root: ref.root,
        project: ref.slug ?? null,
        worktrees: worktreesOf(ref.root),
        projectsRoot: o.claudeProjects ? resolve(o.claudeProjects) : claudeProjectsRoot(),
        state: readAdoptState(),
        transcripts: o.transcripts,
      });
      if (o.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(renderAdoptPlan(plan));
      log("nothing was written or recorded: this is the plan. relay link adopts it, with the files in its pull request");
    });
}
