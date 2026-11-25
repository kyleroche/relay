/**
 * `relay task …`: open, read, review, requeue, close and release tasks. A task is a thread in its project's queue
 * on the team's Vercel Board (`work/<project>`), addressed by the ID the board gave it. Every command acts as this
 * machine's own Vercel login, so what it may do is what the board's grants give that login; approve merges the
 * pull request with the machine's gh login (docs/WORKERS.md).
 */
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { board, detectGitHub, isLaneName, laneNameProblem, MANIFEST_FENCE, manifestFromValue, parseManifestText, WORKER_LANES } from "@relay/core";
import { log, resolveProject } from "./_common.ts";
import { act, openBoard, repoOf } from "./_board.ts";

type Task = board.BoardTask;

function line(t: Task): string {
  const who = t.claim ? ` ${t.claim.actor.split("+").pop()}` : "";
  const pr = t.pr ? ` PR #${t.pr.number}` : "";
  const why = t.state === "failed" ? `  (${(t.reason ?? "").slice(0, 60)})` : t.hold && t.state !== "review" ? `  (${t.hold.reason.slice(0, 60)})` : "";
  return `${t.id.padEnd(12)} ${t.state.padEnd(8)} ${(t.project ?? "-").padEnd(16)} ${(t.lane ?? "-").padEnd(7)}${who}${pr}  ${t.title.slice(0, 70)}${why}`;
}

function show(d: board.TaskDetail): void {
  const t = d.task;
  console.log(`${t.id}  ${t.state}${t.lane ? `  lane ${t.lane}` : ""}${t.model ? `  model ${t.model}` : ""}${t.claim ? `  held by ${t.claim.actor} until ${t.claim.until.slice(11, 16)}Z` : ""}`);
  console.log(`title: ${t.title}`);
  console.log(`queue: ${t.channel}${t.repo ? `  repo ${t.repo}` : ""}${t.base ? `  base ${t.base}` : ""}`);
  if (t.issue) console.log(`issue: https://github.com/${t.issue.repo}/issues/${t.issue.number}`);
  const pr = t.pr ?? d.thread.replies.flatMap((m) => board.blocksOf<board.RunBlock>(m, board.RUN_SCHEMA)).at(-1)?.pr;
  if (pr) console.log(`pr:    ${pr.url}`);
  if (t.evaluates) console.log(`looks at: ${t.evaluates}${t.branch ? ` (${t.branch})` : ""}`);
  if (t.needs.length) console.log(`needs: ${t.needs.join(", ")}`);
  if (t.hold) console.log(`held:  ${t.hold.kind}${t.hold.reason ? `: ${t.hold.reason.slice(0, 200)}` : ""}`);
  if (t.result) console.log(`result: ${t.result.slice(0, 200)}`);
  if (t.reason) console.log(`reason: ${t.reason.slice(0, 200)}`);
  const runs = d.usage.filter((u) => u.kind === "run");
  if (d.usage.length) {
    const sum = (f: (u: board.UsageBlock) => number): number => d.usage.reduce((s, u) => s + f(u), 0);
    const model = runs.at(-1)?.model;
    console.log(`usage: ${runs.length} run${runs.length === 1 ? "" : "s"}, ${sum((u) => u.tokens_in + u.cache_read)} in / ${sum((u) => u.tokens_out)} out, $${sum((u) => u.cost_equiv).toFixed(2)} equiv${model ? ` (${model})` : ""}`);
  }
  for (const n of d.notes.slice(-3)) console.log(`note:  ${n.by} ${n.at.slice(0, 16)}: ${n.text.split("\n")[0]?.slice(0, 120)}`);
  console.log(`made:  ${t.created_at.slice(0, 16)} by ${t.owner}`);
}

/** The `--lane` help: the built-ins by name; a registered worker's lane is checked against the board's workers. */
const LANE_HELP = `${WORKER_LANES.join(", ")} (run by relay work), ${board.ANY_LANE} (whichever code lane is free), or the lane another worker registered (relay work status lists workers and their lanes)`;

export function registerTask(program: Command): void {
  const task = program.command("task").description("Tasks: threads in a project's queue on the team's Vercel Board, with the state the board keeps (docs/WORKERS.md)");

  task
    .command("create")
    .requiredOption("--title <text>")
    .requiredOption("--lane <lane>", LANE_HELP)
    .option("--project <slug>", "project slug (default: the linked project of the cwd)")
    .option("--repo <owner/name>", "the repository to work in (default: the project's)")
    .option("--body <text>", "the task's text (markdown)")
    .option("--body-file <path>", "read the body from a file ('-' for stdin)")
    .option("--manifest <path>", "a relay-nodes manifest (JSON or YAML: workflow, inputs, outputs, model, stage) appended to the body as the fenced block the nodes lane runs")
    .option("--model <id>", "the model the lane should use (fable, gpt-6-astra, …); the lane's default without it")
    .option("--needs <ids>", "tasks that must complete first, comma separated")
    .option("--base <branch>", "start from this branch instead of the repository's default one")
    .option("--plan", "open it as a planning task: a lane reads the repository and proposes tasks, and approving the plan (relay task approve) is what opens them")
    .option("--key <idempotency-key>", "repeat calls with the same key return the same task")
    .option("--cwd <path>")
    .option("--json")
    .description("Open a task in the project's queue, labelled with its lane")
    .action(async (o: { title: string; lane: string; project?: string; repo?: string; body?: string; bodyFile?: string; manifest?: string; model?: string; needs?: string; base?: string; plan?: boolean; key?: string; cwd?: string; json?: boolean }) => {
      if (!isLaneName(o.lane)) throw new Error(`--lane: ${laneNameProblem(o.lane)}`);
      const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
      if (!ref.slug) throw new Error("no project: pass --project or run relay link in the repo");
      let body = o.bodyFile ? readFileSync(o.bodyFile === "-" ? 0 : o.bodyFile, "utf8") : o.body ?? "";
      if (o.manifest) {
        const text = readFileSync(o.manifest, "utf8");
        manifestFromValue(parseManifestText(text)); // throws ManifestError with the line to fix before anything is opened
        body = `${body.trimEnd()}\n\n\`\`\`${MANIFEST_FENCE}\n${text.trim()}\n\`\`\`\n`;
      }
      const slug = ref.slug;
      const repo = o.repo ?? (await repoOf(slug, ref));
      if (!repo) throw new Error(`no repository for project '${slug}': pass --repo owner/name, or register it with relay project add ${slug} --repo owner/name`);
      await act(async () => {
        const b = openBoard();
        const { task: t } = await board.openServedTask(b, {
          project: slug,
          repo,
          title: o.title,
          body,
          lane: o.lane,
          ...(o.model ? { model: o.model } : {}),
          ...(o.needs ? { needs: o.needs.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          ...(o.base ? { base: o.base } : {}),
          ...(o.plan ? { step: "plan" } : {}),
          ...(o.key ? { idempotencyKey: o.key } : {}),
        });
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else {
          console.log(t.id);
          log(`opened in ${t.channel} [${t.state}]${t.hold ? `: ${t.hold.reason}` : ""}`);
        }
      });
    });

  task
    .command("get")
    .argument("<task-id>", "the task's ID on the board")
    .option("--json")
    .description("One task with its state, who holds it, its pull request, usage and the last notes in its thread")
    .action((id: string, o: { json?: boolean }) =>
      act(async () => {
        const d = await board.getTask(openBoard(), id);
        if (o.json) console.log(JSON.stringify({ ...d.task, usage: d.usage, notes: d.notes }, null, 2));
        else show(d);
      }),
    );

  task
    .command("approve")
    .argument("<task-id>", "the task's ID on the board")
    .option("--json")
    .description("Approve a task in review: squash-merge its pull request and delete the branch (or accept its attached outputs), and complete the task")
    .action((id: string, o: { json?: boolean }) =>
      act(async () => {
        const b = openBoard();
        const r = await board.approveTask(b, detectGitHub(), id, { by: (await b.me()).handle });
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else log(`approved ${id}: ${r.pr_url ? `merged ${r.pr_url}${r.merge_sha ? ` (${r.merge_sha.slice(0, 7)})` : ""}${r.branch_deleted ? ", branch deleted" : ""}` : r.task.result}`);
      }),
    );

  task
    .command("changes")
    .argument("<task-id>", "the task's ID on the board")
    .requiredOption("--note <text>", "what should change; posted in the thread and on the PR, and read by the next run")
    .option("--json")
    .description("Send a task in review back to the queue with a note for the next run")
    .action((id: string, o: { note: string; json?: boolean }) =>
      act(async () => {
        const t = await board.requestChanges(openBoard(), detectGitHub(), id, o.note);
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else log(`sent ${id} back: ${t.state}`);
      }),
    );

  task
    .command("requeue")
    .argument("<task-id>", "the task's ID on the board")
    .option("--lane <lane>", `move it to this lane: ${LANE_HELP}`)
    .option("--model <id>", "ask for this model on the next run ('default' goes back to the lane's own)")
    .option("--json")
    .description("Put a failed or held task back in the queue, optionally on another lane or model")
    .action((id: string, o: { lane?: string; model?: string; json?: boolean }) =>
      act(async () => {
        const t = await board.requeueTask(openBoard(), id, { ...(o.lane ? { lane: o.lane } : {}), ...(o.model ? { model: o.model === "default" ? null : o.model } : {}) });
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else log(`${id}: ${t.state}${t.lane ? ` on ${t.lane}` : ""}${t.model ? ` (${t.model})` : ""}`);
      }),
    );

  task
    .command("close")
    .argument("<task-id>", "the task's ID on the board")
    .option("--reason <text>", "why, for the thread and the comment on GitHub")
    .option("--json")
    .description("Finish a task without a merge: canceled on the board, its open pull request and its issue closed on GitHub")
    .action((id: string, o: { reason?: string; json?: boolean }) =>
      act(async () => {
        const r = await board.closeTask(openBoard(), detectGitHub(), id, { ...(o.reason ? { reason: o.reason } : {}) });
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else log(`closed ${id}${r.github.pr_closed ? "; its pull request is closed" : ""}${r.github.issue_closed ? "; its issue is closed" : ""}${r.to_review ? `; ${r.to_review} goes to review without it` : ""}${r.canceled.length ? `; called off ${r.canceled.join(", ")}, which was looking at it` : ""}${r.github.error ? `; GitHub: ${r.github.error}` : ""}`);
      }),
    );

  task
    .command("grant")
    .argument("<task-id>", "the task's ID on the board")
    .option("--set <name>", "a capability set of the project's profile (.relay/project.json): its hosts and its environment variables, by name")
    .option("--cloud <usd>", "a paid sandbox run of this task, up to this many US dollars")
    .option("--json")
    .description("Let one task use what no task has by default, for its text as it stands: a capability set, or a paid sandbox run up to a cap. A grant given before the task's text was edited counts for nothing")
    .action((id: string, o: { set?: string; cloud?: string; json?: boolean }) =>
      act(async () => {
        if ((o.set === undefined) === (o.cloud === undefined)) throw new board.TaskError("say what to grant: --set <name>, or --cloud <usd>", 400);
        const t = await board.grantTask(openBoard(), id, o.set !== undefined ? { set: o.set } : { cloudCapUsd: Number(o.cloud) });
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else log(`granted ${id} ${o.set !== undefined ? `the set ${o.set}` : `a paid sandbox run of up to $${Number(o.cloud).toFixed(2)}`}; a worker that takes your tasks will use it on its next run`);
      }),
    );

  task
    .command("release")
    .argument("<task-id>", "the task's ID on the board")
    .option("--json")
    .description("Lift the injection gate's hold on a task for its text as it stands: it returns to the queue, and only text added later is graded again")
    .action((id: string, o: { json?: boolean }) =>
      act(async () => {
        const t = await board.releaseTask(openBoard(), id);
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else log(`released ${id}: ${t.state}`);
      }),
    );

  task
    .command("ls")
    .option("--project <slug>")
    .option("--state <state>", `one of ${board.RELAY_STATES.join(", ")}, open (the default) or all`)
    .option("--lane <lane>")
    .option("-n <n>", "rows", "50")
    .option("--json")
    .description("Tasks oldest first, the order the queue works them in")
    .action((o: { project?: string; state?: string; lane?: string; n: string; json?: boolean }) =>
      act(async () => {
        const state = o.state as board.RelayState | "open" | "all" | undefined;
        if (state && state !== "open" && state !== "all" && !(board.RELAY_STATES as readonly string[]).includes(state)) throw new board.TaskError(`--state must be one of ${board.RELAY_STATES.join(", ")}, open or all`, 400);
        const rows = await board.listTasks(openBoard(), { ...(o.project ? { project: o.project } : {}), ...(state ? { state } : {}), ...(o.lane ? { lane: o.lane } : {}), limit: Number(o.n) || 50 });
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else for (const t of rows) console.log(line(t));
      }),
    );
}
