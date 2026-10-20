/**
 * Normalize GitHub webhook payloads into event rows. Kinds emitted here are documented in
 * lib/events.ts. Returns null for deliveries that are not events of record (ping, edits, syncs).
 * `issue_comment` deliveries carrying the runner's usage block go through `githubEvents`, which
 * may yield two rows (step.usage and, in review mode, pr.review).
 */
import { isWorkerLane, WORKER_LANES } from "@relay/core";
import type { Lane, NewEvent } from "@/lib/types";
import { resolveProject, type TaskProjectLookup } from "./project.ts";
import { parseUsageComment, senderTrusted, usageEvents } from "./usage.ts";

type Json = Record<string, unknown>;

const get = <T = unknown>(obj: unknown, path: string): T | undefined =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj) as T | undefined;

function actorOf(payload: Json): string {
  const login = get<string>(payload, "sender.login") ?? "unknown";
  const type = get<string>(payload, "sender.type");
  if (type === "Bot" || login.endsWith("[bot]")) return `bot:${login.replace(/\[bot\]$/, "")}`;
  return `human:${login}`;
}

/** The worker lanes as a regex alternative, so a lane added to core's WORKER_LANES is read here without another edit. */
const LANE_ALT = WORKER_LANES.join("|");
const LANE_LABEL = new RegExp(`^agent:(${LANE_ALT})$`);
const RELAY_BRANCH = new RegExp(`^relay\\/(?:(${LANE_ALT})-(\\d+)|(\\d+)-(${LANE_ALT}))(?:$|[-/])`);

function laneOf(label: string | undefined): Lane | null {
  const m = LANE_LABEL.exec(label ?? "");
  return m?.[1] && isWorkerLane(m[1]) ? m[1] : null;
}

function laneFromLabels(labels: unknown): Lane | null {
  if (!Array.isArray(labels)) return null;
  for (const l of labels) {
    const lane = laneOf(get<string>(l, "name"));
    if (lane) return lane;
  }
  return null;
}

/**
 * A runner branch: `relay/<lane>-<issue>` as run-lane.sh names it (the older `relay/<issue>-<lane>` spelling is
 * still read). Null for any other branch.
 */
function relayBranch(branch: string | null | undefined): { lane: Lane; issue: number } | null {
  const m = RELAY_BRANCH.exec(branch ?? "");
  if (!m) return null;
  const lane = (m[1] ?? m[4]) as Lane;
  const issue = Number(m[2] ?? m[3]);
  return Number.isInteger(issue) ? { lane, issue } : null;
}

/**
 * A pull request the vendor's cloud tier opened for a cloud lane (docs/RUNNERS.md "Cloud lanes"). Claude Code
 * cloud sessions, Routines and claude-code-action push `claude/` branches; Codex cloud pushes `codex/` branches.
 * When the branch is not telling, the bot login is: `claude[bot]` is the Claude GitHub App (claude-code-action),
 * `chatgpt-codex-connector[bot]` is the Codex connector. Cloud sessions that push as the user's own GitHub login
 * are recognised by the branch alone.
 */
function cloudLaneOf(pr: Json, payload: Json): { lane: Lane; cloud: "claude-cloud" | "codex-cloud" } | null {
  const branch = get<string>(pr, "head.ref") ?? "";
  if (/^claude\//.test(branch)) return { lane: "claude", cloud: "claude-cloud" };
  if (/^codex\//.test(branch)) return { lane: "codex", cloud: "codex-cloud" };
  const login = (get<string>(pr, "user.login") ?? get<string>(payload, "sender.login") ?? "").toLowerCase();
  if (login === "claude[bot]") return { lane: "claude", cloud: "claude-cloud" };
  if (login === "chatgpt-codex-connector[bot]" || login === "chatgpt-codex-connector") return { lane: "codex", cloud: "codex-cloud" };
  return null;
}

/** "Closes #12" / "Fixes #12" in a PR body, else the relay branch convention relay/<lane>-<issue>. */
function linkedIssue(pr: Json): number | null {
  const body = get<string>(pr, "body") ?? "";
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(body);
  if (m?.[1]) return Number(m[1]);
  return relayBranch(get<string>(pr, "head.ref"))?.issue ?? null;
}

/**
 * Every row a delivery produces, with its project resolved (`resolveProject`: the task row, a `production:<slug>`
 * label, the repository's name). Comments are async (trusted-sender lookup); everything else is `normalizeGitHub`.
 */
export async function githubEvents(eventName: string, payload: Json, deliveryId: string, deps: { taskProject?: TaskProjectLookup } = {}): Promise<NewEvent[]> {
  const rows = await rawGithubEvents(eventName, payload, deliveryId);
  const labels = get(payload, "issue.labels") ?? get(payload, "pull_request.labels");
  const repoName = get<string>(payload, "repository.name") ?? null;
  return Promise.all(rows.map(async (e) => ({ ...e, project: await resolveProject({ repo: e.repo ?? null, issue: e.issue ?? null, labels, repoName }, deps.taskProject) })));
}

async function rawGithubEvents(eventName: string, payload: Json, deliveryId: string): Promise<NewEvent[]> {
  if (eventName === "issue_comment") {
    const action = get<string>(payload, "action");
    if (action !== "created" && action !== "edited") return [];
    const comment = get<Json>(payload, "comment");
    const issue = get<Json>(payload, "issue");
    if (!comment || !issue || !get(issue, "pull_request")) return [];
    const block = parseUsageComment(get<string>(comment, "body") ?? "");
    if (!block) return [];
    const repo = get<string>(payload, "repository.full_name") ?? null;
    const login = get<string>(comment, "user.login") ?? "unknown";
    const trusted = await senderTrusted(repo, login);
    return usageEvents(block, {
      repo,
      project: get<string>(payload, "repository.name") ?? null,
      pr: get<number>(issue, "number") ?? null,
      url: get<string>(comment, "html_url") ?? null,
      commentId: get<number | string>(comment, "id") ?? deliveryId,
      sender: login,
      body: get<string>(comment, "body") ?? "",
      trusted,
      ...(get<string>(comment, "created_at") ? { ts: get<string>(comment, "created_at") as string } : {}),
    });
  }
  const one = normalizeGitHub(eventName, payload, deliveryId);
  return one ? [one] : [];
}

/** One delivery as a row, project = the repository's name (`githubEvents` resolves the shared-repo cases). */
export function normalizeGitHub(eventName: string, payload: Json, deliveryId: string): NewEvent | null {
  const repo = get<string>(payload, "repository.full_name") ?? null;
  const project = get<string>(payload, "repository.name") ?? null;
  const base = { repo, project, dedupe_key: `github:${deliveryId}`, actor: actorOf(payload) };
  const action = get<string>(payload, "action");

  switch (eventName) {
    case "ping":
      return null;

    case "issues": {
      const issue = get<Json>(payload, "issue");
      if (!issue) return null;
      const number = get<number>(issue, "number") ?? null;
      const title = get<string>(issue, "title") ?? "";
      const url = get<string>(issue, "html_url") ?? null;
      const lane = laneFromLabels(get(issue, "labels"));
      if (action === "opened" || action === "reopened") {
        return { ...base, kind: "issue.opened", issue: number, lane, summary: title, url, payload: { action, labels: get(issue, "labels") } };
      }
      if (action === "labeled") {
        const label = get<string>(payload, "label.name");
        const l = laneOf(label);
        if (!l) return null; // only lane labels are events of record
        return { ...base, kind: "issue.labeled", issue: number, lane: l, summary: `Labelled ${label}`, url, payload: { label, title } };
      }
      if (action === "closed") {
        return { ...base, kind: "issue.closed", issue: number, lane, summary: `Closed #${number}: ${title}`, url, payload: { state_reason: get(issue, "state_reason") } };
      }
      return null;
    }

    case "pull_request": {
      const pr = get<Json>(payload, "pull_request");
      if (!pr) return null;
      const number = get<number>(pr, "number") ?? null;
      const title = get<string>(pr, "title") ?? "";
      const url = get<string>(pr, "html_url") ?? null;
      const issue = linkedIssue(pr);
      const branch = get<string>(pr, "head.ref") ?? null;
      const cloud = cloudLaneOf(pr, payload);
      const lane = relayBranch(branch)?.lane ?? cloud?.lane ?? laneFromLabels(get(pr, "labels"));
      // A cloud-lane PR is the lane's work even when the vendor pushed it under the user's own GitHub login.
      const common = { ...base, pr: number, issue, url, lane, ...(cloud ? { actor: `agent:${cloud.lane}` } : {}) };
      const cloudPayload = cloud ? { cloud: cloud.cloud, author: get<string>(pr, "user.login") ?? null } : {};
      if (action === "opened" || action === "reopened" || action === "ready_for_review") {
        return { ...common, kind: "pr.opened", summary: issue ? `${title} (#${issue})` : title, payload: { branch, additions: get(pr, "additions"), deletions: get(pr, "deletions"), ...cloudPayload } };
      }
      if (action === "closed") {
        const merged = Boolean(get(pr, "merged"));
        return merged
          ? { ...common, kind: "pr.merged", summary: `Merged #${number} into ${get<string>(pr, "base.ref") ?? "main"}`, payload: { merge_commit: get(pr, "merge_commit_sha") } }
          : { ...common, kind: "pr.closed", summary: `Closed #${number} without merge`, payload: {} };
      }
      return null;
    }

    case "pull_request_review": {
      if (action !== "submitted") return null;
      const review = get<Json>(payload, "review");
      const pr = get<Json>(payload, "pull_request");
      const state = (get<string>(review, "state") ?? "commented").toLowerCase();
      const number = get<number>(pr, "number") ?? null;
      const body = (get<string>(review, "body") ?? "").split("\n")[0]?.slice(0, 120) ?? "";
      const verb = state === "approved" ? "Approved" : state === "changes_requested" ? "Requested changes on" : "Commented on";
      return {
        ...base,
        kind: "pr.review",
        pr: number,
        issue: pr ? linkedIssue(pr) : null,
        summary: body ? `${verb} #${number}: ${body}` : `${verb} #${number}`,
        url: get<string>(review, "html_url") ?? null,
        payload: { state },
      };
    }

    case "workflow_run": {
      if (action !== "completed") return null;
      const run = get<Json>(payload, "workflow_run");
      const conclusion = get<string>(run, "conclusion") ?? "unknown";
      const name = get<string>(run, "name") ?? "workflow";
      const branch = get<string>(run, "head_branch") ?? "";
      const prs = get<Json[]>(run, "pull_requests") ?? [];
      const pr = get<number>(prs[0], "number") ?? null;
      const started = get<string>(run, "run_started_at");
      const updated = get<string>(run, "updated_at");
      const duration = started && updated ? new Date(updated).getTime() - new Date(started).getTime() : null;
      return {
        ...base,
        actor: "bot:github-actions",
        kind: "workflow.run",
        pr,
        issue: relayBranch(branch)?.issue ?? null,
        duration_ms: duration,
        summary: `${name} ${conclusion === "success" ? "passed" : conclusion} on ${branch}`,
        url: get<string>(run, "html_url") ?? null,
        payload: { conclusion, event: get(run, "event") },
      };
    }

    case "deployment_status": {
      const status = get<Json>(payload, "deployment_status");
      const state = get<string>(status, "state");
      if (state !== "success" && state !== "failure" && state !== "error") return null;
      const env = get<string>(payload, "deployment.environment") ?? "preview";
      const ref = get<string>(payload, "deployment.ref") ?? "";
      return {
        ...base,
        actor: actorOf(payload).replace(/^human:/, "bot:"),
        kind: state === "success" ? "preview.ready" : "preview.failed",
        issue: relayBranch(ref)?.issue ?? null,
        summary: state === "success" ? `${env} deployed for ${ref}` : `${env} deployment ${state} for ${ref}`,
        url: get<string>(status, "environment_url") ?? get<string>(status, "target_url") ?? null,
        // ref and sha let deriveTaskStatus match the deployment to a task's branch (a deployment carries no PR number)
        payload: { environment: env, state, ref: ref || null, sha: get<string>(payload, "deployment.sha") ?? null, description: get<string>(status, "description") ?? null },
      };
    }

    default:
      return null;
  }
}
