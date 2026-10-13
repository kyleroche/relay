/**
 * Normalize GitHub webhook payloads into event rows. Kinds emitted here are documented in
 * lib/events.ts. Returns null for deliveries that are not events of record (ping, edits, syncs).
 */
import type { Lane, NewEvent } from "@/lib/types";

type Json = Record<string, unknown>;

const get = <T = unknown>(obj: unknown, path: string): T | undefined =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj) as T | undefined;

function actorOf(payload: Json): string {
  const login = get<string>(payload, "sender.login") ?? "unknown";
  const type = get<string>(payload, "sender.type");
  if (type === "Bot" || login.endsWith("[bot]")) return `bot:${login.replace(/\[bot\]$/, "")}`;
  return `human:${login}`;
}

function laneOf(label: string | undefined): Lane | null {
  const m = /^agent:(claude|codex|grok)$/.exec(label ?? "");
  return (m?.[1] as Lane | undefined) ?? null;
}

function laneFromLabels(labels: unknown): Lane | null {
  if (!Array.isArray(labels)) return null;
  for (const l of labels) {
    const lane = laneOf(get<string>(l, "name"));
    if (lane) return lane;
  }
  return null;
}

/** "Closes #12" / "Fixes #12" in a PR body, else the relay branch convention relay/<issue>-<lane>. */
function linkedIssue(pr: Json): number | null {
  const body = get<string>(pr, "body") ?? "";
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(body);
  if (m?.[1]) return Number(m[1]);
  const branch = get<string>(pr, "head.ref") ?? "";
  const b = /^relay\/(\d+)-/.exec(branch);
  return b?.[1] ? Number(b[1]) : null;
}

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
        return { ...base, kind: "issue.labeled", issue: number, lane: l, summary: `Labelled ${label}`, url, payload: { label } };
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
      const lane = laneOf(`agent:${(branch ?? "").split("-").pop() ?? ""}`) ?? laneFromLabels(get(pr, "labels"));
      const common = { ...base, pr: number, issue, url, lane };
      if (action === "opened" || action === "reopened" || action === "ready_for_review") {
        return { ...common, kind: "pr.opened", summary: issue ? `${title} (#${issue})` : title, payload: { branch, additions: get(pr, "additions"), deletions: get(pr, "deletions") } };
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
      const issueMatch = /^relay\/(\d+)-/.exec(branch);
      const started = get<string>(run, "run_started_at");
      const updated = get<string>(run, "updated_at");
      const duration = started && updated ? new Date(updated).getTime() - new Date(started).getTime() : null;
      return {
        ...base,
        actor: "bot:github-actions",
        kind: "workflow.run",
        pr,
        issue: issueMatch?.[1] ? Number(issueMatch[1]) : null,
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
      const issueMatch = /^relay\/(\d+)-/.exec(ref);
      return {
        ...base,
        actor: actorOf(payload).replace(/^human:/, "bot:"),
        kind: state === "success" ? "preview.ready" : "preview.failed",
        issue: issueMatch?.[1] ? Number(issueMatch[1]) : null,
        summary: state === "success" ? `${env} deployed for ${ref}` : `${env} deployment ${state} for ${ref}`,
        url: get<string>(status, "environment_url") ?? get<string>(status, "target_url") ?? null,
        payload: { environment: env, state },
      };
    }

    default:
      return null;
  }
}
