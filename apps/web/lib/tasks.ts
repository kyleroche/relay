/** Shared bits of the task pages: state copy and tones, the page path, the prompt that drives a review from chat. */
import type { repo, TaskState, TaskView } from "@relay/core";
import { taskTitle as coreTaskTitle } from "@relay/core/tasks/station.ts";
import type { StatusTone } from "@/components/ui/status-badge";
import { SITE_URL } from "./site.ts";

export const STATE_HINT: Record<TaskState, string> = {
  queued: "Waiting for a worker that serves its lane (or sent back with a note or requeued, waiting for the next run).",
  held: "The injection gate flagged the issue text as instructions aimed at the agent; no worker runs it until someone reads it and releases it.",
  claimed: "A worker holds the lease and is cloning the repository.",
  running: "The lane is working in a fresh clone on the worker.",
  review: "A pull request is open, or an asset was delivered on the issue. Look at the preview or the asset, then approve, or send it back with a note.",
  done: "Merged (by an approval here or on GitHub), the asset was approved, or the issue was closed.",
  failed: "The lane exited with an error, made no changes, or timed out; the run's summary says what happened.",
};

export const STATE_TONE: Record<TaskState, StatusTone> = {
  queued: "muted",
  held: "warn",
  claimed: "muted",
  running: "primary",
  review: "warn",
  done: "ok",
  failed: "bad",
};

/** The tone as a text color class, for the one place a state word is colored outside a badge (the Tasks group headers). */
export const TONE_TEXT: Record<StatusTone, string> = {
  muted: "text-muted-foreground",
  primary: "text-primary",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

/** The prompt to hand an agent that should drive the review from chat (DESIGN.md, item 7: self-serve first). */
export const REVIEW_AGENT_PROMPT = `Connect to the relay MCP server at ${SITE_URL}/mcp (scopes tasks:read tasks:write). Call relay_task_list({state: "review"}) and, for each task, relay_task_get(task_id): tell me the title, pr_url and preview_url. When I say "approve <task>" call relay_task_approve({id}); when I say "send back <task>: <note>" call relay_task_request_changes({id, note}). Subscribe with relay_webhook_subscribe to preview.ready, task.approved, task.changes_requested, run.finished and run.failed so you can tell me when a preview is up.`;

export const taskPagePath = (t: Pick<TaskView, "repo" | "issue">): string => `/tasks/${t.repo}/${t.issue}`;

/** The issue title: the task row's own, else the rows that carry it (issue.opened's summary, task.created's "<id>: <title>"), else "#n". The one in `@relay/core` (tasks/station.ts). */
export const taskTitle = (task: Pick<TaskView, "id" | "issue"> & { title?: string | null }, events: repo.EventRow[]): string => coreTaskTitle(task, events);
