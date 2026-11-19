/**
 * `relay steps …`: the steps a project runs around its tasks (docs/STEPS.md). A step is a Markdown file; relay ships
 * some, a user keeps their own under ~/.harness/steps, and a project keeps its own under .relay/steps and lists the
 * ones it runs in .relay/project.json. Everything here reads and writes those files in the working tree; a job reads
 * them from the default branch, so a change takes effect once it is merged.
 */
import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { board, diskFiles, PROFILE_PATH, projectSteps, relayHome, runtimePaths, STEPS_DIR, type ProjectSteps, type Step } from "@relay/core";
import { log, resolveProject } from "./_common.ts";
import { act, openBoard, repoOf } from "./_board.ts";

const userDir = (): string => join(relayHome(), "steps");

function load(root: string): ProjectSteps {
  return projectSteps({ relayDir: runtimePaths().stepsDir, userDir: userDir(), project: diskFiles(root) });
}

function need(steps: ProjectSteps, name: string): Step {
  const step = steps.library.get(name);
  if (!step) throw new Error(`no step named '${name}'; relay steps ls shows the ones that exist`);
  return step;
}

/** Rewrite the profile's `steps` list, leaving everything else in the file as it was. */
function writeList(root: string, change: (list: string[]) => string[]): string[] {
  const path = join(root, PROFILE_PATH);
  const profile = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as { steps?: string[] };
  const next = change(Array.isArray(profile.steps) ? profile.steps : []);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...profile, steps: next }, null, 2) + "\n");
  return next;
}

const row = (s: Step): string => `${s.name.padEnd(16)} ${s.when.padEnd(10)} ${s.lane.padEnd(7)} ${s.mode.padEnd(10)} ${s.source.padEnd(8)} ${s.description}`;

export function registerSteps(program: Command): void {
  const steps = program.command("steps").description("The steps this project runs around a task: comment cleanup before the PR, a second lane's eval after it, cleanup passes on demand (docs/STEPS.md)");

  steps
    .command("ls")
    .option("--cwd <path>")
    .option("--json")
    .description("The steps this repository runs, in order, and every step it could, with where each comes from")
    .action((o: { cwd?: string; json?: boolean }) => {
      const { root } = resolveProject(o.cwd ? { cwd: o.cwd } : {});
      const p = load(root);
      if (o.json) {
        console.log(JSON.stringify({ enabled: p.enabled.map((s) => s.name), steps: [...p.library.values()], problems: p.problems }, null, 2));
        return;
      }
      console.log(p.enabled.length ? `runs, in order: ${p.enabled.map((s) => s.name).join(", ")}  (${join(root, PROFILE_PATH)})` : `runs no steps yet: relay steps add <name> lists one in ${PROFILE_PATH}`);
      console.log(`\n${"name".padEnd(16)} ${"when".padEnd(10)} ${"lane".padEnd(7)} ${"mode".padEnd(10)} ${"from".padEnd(8)} what`);
      for (const s of [...p.library.values()].sort((a, b) => a.name.localeCompare(b.name))) console.log(row(s));
      for (const problem of p.problems) log(`problem: ${problem}`);
      if (p.problems.length) process.exitCode = 1;
    });

  steps
    .command("show")
    .argument("<name>")
    .option("--cwd <path>")
    .description("One step as this repository would run it: its settings, where it comes from, and its instruction")
    .action((name: string, o: { cwd?: string }) => {
      const s = need(load(resolveProject(o.cwd ? { cwd: o.cwd } : {}).root), name);
      console.log(`${s.name}  (${s.source}: ${s.path})\nwhen ${s.when}, lane ${s.lane}${s.model ? `, model ${s.model}` : ""}, ${s.mode}\n${s.description}\n\n${s.body}`);
    });

  steps
    .command("eject")
    .argument("<name>")
    .option("--user", "copy it to ~/.harness/steps, for every project on this machine, instead of this repository")
    .option("--force", "replace a copy that is already there")
    .option("--cwd <path>")
    .description("Copy a step into this repository (.relay/steps) so you can change it; the nearest copy is the one that runs")
    .action((name: string, o: { user?: boolean; force?: boolean; cwd?: string }) => {
      const { root } = resolveProject(o.cwd ? { cwd: o.cwd } : {});
      const s = need(load(root), name);
      const to = o.user ? join(userDir(), `${name}.md`) : join(root, STEPS_DIR, `${name}.md`);
      if (s.path === to) throw new Error(`${to} is already the copy that runs; edit it`);
      if (existsSync(to) && !o.force) throw new Error(`${to} exists; --force replaces it`);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(s.path, "utf8"));
      log(`copied ${s.path} to ${to}${o.user ? "" : "; commit it, and it runs once it is on the default branch"}`);
    });

  steps
    .command("add")
    .argument("<name>")
    .option("--cwd <path>")
    .description(`List a step in ${PROFILE_PATH}, so this repository's tasks run it`)
    .action((name: string, o: { cwd?: string }) => {
      const { root } = resolveProject(o.cwd ? { cwd: o.cwd } : {});
      const s = need(load(root), name);
      if (s.when === "respond") throw new Error(`'${name}' answers another step's findings; it runs by itself when that step is listed`);
      if (s.when === "task") throw new Error(`'${name}' is a task of its own, not part of every task: relay steps run ${name}`);
      const list = writeList(root, (l) => (l.includes(name) ? l : [...l, name]));
      log(`${PROFILE_PATH} now lists: ${list.join(", ")}; commit it, and it takes effect once it is on the default branch`);
    });

  steps
    .command("rm")
    .argument("<name>")
    .option("--cwd <path>")
    .description(`Take a step off the list in ${PROFILE_PATH}`)
    .action((name: string, o: { cwd?: string }) => {
      const { root } = resolveProject(o.cwd ? { cwd: o.cwd } : {});
      const list = writeList(root, (l) => l.filter((x) => x !== name));
      log(`${PROFILE_PATH} now lists: ${list.join(", ") || "no steps"}`);
    });

  steps
    .command("run")
    .argument("<name>", "a step whose `when` is task, such as cleanup")
    .option("--project <slug>", "project slug (default: the linked project of the cwd)")
    .option("--repo <owner/name>", "the repository to work in (default: the project's)")
    .option("--lane <lane>", "the lane to run it on (default: the step's own)")
    .option("--model <id>", "the model the lane should use (default: the step's own, else the lane's)")
    .option("--scope <path>", "a directory or package to stay inside")
    .option("--cwd <path>")
    .option("--json")
    .description("Open a task in the project's queue that runs a step by itself, in a fresh clone, with its own pull request")
    .action(async (name: string, o: { project?: string; repo?: string; lane?: string; model?: string; scope?: string; cwd?: string; json?: boolean }) => {
      const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
      if (!ref.slug) throw new Error("no project: pass --project or run relay link in the repo");
      const s = need(load(ref.root), name);
      if (s.when !== "task") throw new Error(`'${name}' runs ${s.when}, as part of another task; only a step whose when is task can be run by itself`);
      const slug = ref.slug;
      const repo = o.repo ?? (await repoOf(slug, ref));
      if (!repo) throw new Error(`no repository for project '${slug}': pass --repo owner/name`);
      const model = o.model ?? s.model;
      await act(async () => {
        const t = await board.openTask(openBoard(), { project: slug, repo, title: o.scope ? `${name}: ${o.scope}` : name, body: `${s.body}${o.scope ? `\n\nScope: stay inside \`${o.scope}\`.` : ""}`, lane: o.lane ?? s.lane, step: name, ...(model ? { model } : {}) });
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else {
          console.log(t.id);
          log(`opened ${name} in ${t.channel} [${t.state}]`);
        }
      });
    });
}
