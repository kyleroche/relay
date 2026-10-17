/** Shared bits of the task pages: state copy and tones, the page path, the prompt that drives a review from chat. */
import type { repo, TaskState, TaskView } from "@relay/core";
import { SITE_URL } from "./site.ts";

export const STATE_HINT: Record<TaskState, string> = {
  queued: "Waiting for a worker that serves its lane (or sent back with a note or requeued, waiting for the next run).",
  claimed: "A worker holds the lease and is cloning the repository.",
  running: "The lane is working in a fresh clone on the worker.",
  review: "A pull request is open. Look at the preview, then approve or request changes.",
  done: "Merged (by an approval here or on GitHub) or the issue was closed.",
  failed: "The lane exited with an error, made no changes, or timed out; the run's summary says what happened.",
};

export const STATE_TONE: Record<TaskState, string> = {
  queued: "text-muted-foreground",
  claimed: "text-muted-foreground",
  running: "text-primary",
  review: "text-warn",
  done: "text-ok",
  failed: "text-bad",
};

/** The prompt to hand an agent that should drive the review from chat (DESIGN.md, item 7: self-serve first). */
export const REVIEW_AGENT_PROMPT = `Connect to the relay MCP server at ${SITE_URL}/mcp (scopes tasks:read tasks:write). Call relay_task_list({state: "review"}) and, for each task, relay_task_get(task_id): tell me the title, pr_url and preview_url. When I say "approve <task>" call relay_task_approve({id}); when I say "send back <task>: <note>" call relay_task_request_changes({id, note}). Subscribe with relay_webhook_subscribe to preview.ready, task.approved, task.changes_requested, run.finished and run.failed so you can tell me when a preview is up.`;

export const taskPagePath = (t: Pick<TaskView, "repo" | "issue">): string => `/tasks/${t.repo}/${t.issue}`;

/** The issue title, from the rows that carry it (issue.opened's summary, task.created's "<id>: <title>"), else "#n". */
export function taskTitle(task: Pick<TaskView, "id" | "issue">, events: repo.EventRow[]): string {
  const opened = events.find((e) => e.kind === "issue.opened" && e.summary);
  if (opened) return opened.summary;
  const created = events.find((e) => e.kind === "task.created" && e.summary.startsWith(`${task.id}: `));
  if (created) return created.summary.slice(task.id.length + 2);
  const pr = events.find((e) => e.kind === "pr.opened" && e.summary);
  if (pr) return pr.summary.replace(/\s*\(#\d+\)\s*$/, "");
  return `#${task.issue}`;
}
