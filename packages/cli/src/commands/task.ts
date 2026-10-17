/**
 * `relay task …`: open, read, review, requeue and release tasks (GitHub issues with a lane label, addressed as owner/repo#n). Locally
 * the issue is opened and the PR merged with the machine's gh login; in site mode the site does it with its own
 * GitHub credential. State is derived from the feed every time it is asked for (docs/INTEGRATIONS.md).
 */
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { TASK_LANES, TASK_PRIORITIES, TASK_STATES, isTaskState, type TaskLane, type TaskPriority, type TaskView } from "@relay/core";
import { log, openReady, resolveProject } from "./_common.ts";

function line(t: TaskView): string {
  const who = t.runner ? ` ${t.runner}` : "";
  const pr = t.pr ? ` PR #${t.pr}` : "";
  return `${t.id.padEnd(28)} ${t.state.padEnd(8)} ${(t.lane ?? "-").padEnd(7)}${who}${pr}  ${(t.summary ?? "").slice(0, 70)}`;
}

function show(t: TaskView): void {
  console.log(`${t.id}  ${t.state}${t.lane ? `  lane ${t.lane}` : ""}${t.runner ? `  ${t.runner}` : ""}`);
  console.log(`issue: ${t.issue_url}${t.pr_url ? `\npr:    ${t.pr_url}` : ""}${t.branch ? `\nbranch: ${t.branch}` : ""}`);
  if (t.preview_url || t.preview_state !== "none") console.log(`preview: ${t.preview_state}${t.preview_url ? ` ${t.preview_url}` : ""}`);
  if (t.run_summary) console.log(`run:   ${t.run_summary.slice(0, 200)}`);
  if (t.usage) console.log(`usage: ${t.usage.runs} run${t.usage.runs === 1 ? "" : "s"}, ${t.usage.tokens_in + t.usage.cache_read} in / ${t.usage.tokens_out} out, $${t.usage.cost_equiv.toFixed(2)} equiv${t.usage.model ? ` (${t.usage.model})` : ""}`);
  if (t.review.decided) console.log(`review: ${t.review.decided.replace("_", " ")} by ${t.review.by} ${t.review.at?.slice(0, 16) ?? ""}${t.review.note ? `: ${t.review.note.split("\n")[0]?.slice(0, 120)}` : ""}`);
  if (t.merged_at) console.log(`merged: ${t.merged_at.slice(0, 16)}`);
  console.log(`last:  ${t.last_kind ?? "-"} ${t.updated_at ? t.updated_at.slice(0, 16) : ""} ${t.summary ?? ""}`.trimEnd());
  console.log(`events: ${t.events}  created ${t.created_at.slice(0, 16)} by ${t.created_by}${t.idempotency_key ? `  key ${t.idempotency_key}` : ""}`);
}

export function registerTask(program: Command): void {
  const task = program.command("task").description("Tasks: GitHub issues with a lane label, with state derived from the feed (docs/INTEGRATIONS.md)");

  task
    .command("create")
    .requiredOption("--title <text>")
    .requiredOption("--lane <lane>", `one of ${TASK_LANES.join(", ")}`)
    .option("--project <slug>", "project slug (default: the linked project of the cwd)")
    .option("--body <text>", "issue body (markdown)")
    .option("--body-file <path>", "read the body from a file ('-' for stdin)")
    .option("--priority <p>", `one of ${TASK_PRIORITIES.join(", ")}`)
    .option("--key <idempotency-key>", "repeat calls with the same key return the same task")
    .option("--cwd <path>")
    .option("--json")
    .description("Open a task: a GitHub issue with agent:<lane> (and priority:<p>) labels")
    .action(async (o: { title: string; lane: string; project?: string; body?: string; bodyFile?: string; priority?: string; key?: string; cwd?: string; json?: boolean }) => {
      if (!(TASK_LANES as readonly string[]).includes(o.lane)) throw new Error(`--lane must be one of ${TASK_LANES.join(", ")}`);
      if (o.priority && !(TASK_PRIORITIES as readonly string[]).includes(o.priority)) throw new Error(`--priority must be one of ${TASK_PRIORITIES.join(", ")}`);
      const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
      if (!ref.slug) throw new Error("no project: pass --project or run relay link in the repo");
      const body = o.bodyFile ? readFileSync(o.bodyFile === "-" ? 0 : o.bodyFile, "utf8") : o.body ?? "";
      const h = await openReady();
      try {
        const r = await h.client.createTask({ project: ref.slug, title: o.title, body, lane: o.lane as TaskLane, ...(o.priority ? { priority: o.priority as TaskPriority } : {}), idempotency_key: o.key ?? null });
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(r.task_id);
          log(`${r.created ? "opened" : "already open (same key)"}: ${r.issue_url} [${r.task.state}]`);
        }
      } finally {
        await h.close();
      }
    });

  task
    .command("get")
    .argument("<task-id>", "owner/repo#n")
    .option("--json")
    .description("One task with its derived state, runner, PR and last summary")
    .action(async (id: string, o: { json?: boolean }) => {
      const h = await openReady();
      try {
        const t = await h.client.getTask(id);
        if (!t) {
          log(`no task ${id}`);
          process.exitCode = 1;
          return;
        }
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else show(t);
      } finally {
        await h.close();
      }
    });

  task
    .command("approve")
    .argument("<task-id>", "owner/repo#n")
    .option("--json")
    .description("Approve a task in review: squash-merge its PR, delete the branch, record task.approved (the task is done)")
    .action(async (id: string, o: { json?: boolean }) => {
      const h = await openReady();
      try {
        const t = await h.client.approveTask(id);
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else {
          log(`approved and merged ${t.pr_url ?? `PR #${t.pr}`}`);
          show(t);
        }
      } finally {
        await h.close();
      }
    });

  task
    .command("changes")
    .argument("<task-id>", "owner/repo#n")
    .requiredOption("--note <text>", "what should change; posted on the PR and handed to the next run's brief")
    .option("--json")
    .description("Request changes on a task in review: comment on the PR, record task.changes_requested, queue it again")
    .action(async (id: string, o: { note: string; json?: boolean }) => {
      const h = await openReady();
      try {
        const t = await h.client.requestChanges(id, o.note);
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else {
          log(`changes requested on ${t.pr_url ?? `PR #${t.pr}`}; the task is ${t.state} and the next run gets your note`);
          show(t);
        }
      } finally {
        await h.close();
      }
    });

  task
    .command("requeue")
    .argument("<task-id>", "owner/repo#n")
    .option("--lane <lane>", `move it to this lane (one of ${TASK_LANES.join(", ")}); the agent:* label on the issue follows`)
    .option("--reason <text>", "why, for the feed")
    .option("--json")
    .description("Put a task back in the queue from any state but done: release its claim, move its lane label, record task.requeued (a worker claims it again)")
    .action(async (id: string, o: { lane?: string; reason?: string; json?: boolean }) => {
      if (o.lane && !(TASK_LANES as readonly string[]).includes(o.lane)) throw new Error(`--lane must be one of ${TASK_LANES.join(", ")}`);
      const h = await openReady();
      try {
        const t = await h.client.requeueTask(id, { lane: o.lane ?? null, reason: o.reason ?? null });
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else {
          log(`requeued; the task is ${t.state}${t.lane ? ` on the ${t.lane} lane` : ""}`);
          show(t);
        }
      } finally {
        await h.close();
      }
    });

  task
    .command("release")
    .argument("<task-id>", "owner/repo#n")
    .option("--note <text>", "why it is safe to run, for the feed")
    .option("--json")
    .description("Release a task the injection gate held: record task.released and queue it again (docs/SECURITY.md, \"The gate\")")
    .action(async (id: string, o: { note?: string; json?: boolean }) => {
      const h = await openReady();
      try {
        const t = await h.client.releaseTask(id, { note: o.note ?? null });
        if (o.json) console.log(JSON.stringify(t, null, 2));
        else {
          log(`released; the task is ${t.state}${t.lane ? ` on the ${t.lane} lane` : ""} (the worker's gate grades it again)`);
          show(t);
        }
      } finally {
        await h.close();
      }
    });

  task
    .command("ls")
    .option("--project <slug>")
    .option("--state <state>", `one of ${TASK_STATES.join(", ")}`)
    .option("-n <n>", "rows", "50")
    .option("--json")
    .description("Tasks with derived state, newest first")
    .action(async (o: { project?: string; state?: string; n: string; json?: boolean }) => {
      if (o.state && !isTaskState(o.state)) throw new Error(`--state must be one of ${TASK_STATES.join(", ")}`);
      const h = await openReady();
      try {
        const rows = await h.client.listTasks({ ...(o.project ? { project: o.project } : {}), ...(o.state && isTaskState(o.state) ? { state: o.state } : {}), limit: Number(o.n) });
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else {
          if (!rows.length) log("no tasks");
          for (const t of rows) console.log(line(t));
        }
      } finally {
        await h.close();
      }
    });
}
