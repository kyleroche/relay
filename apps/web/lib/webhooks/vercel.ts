/**
 * Normalize Vercel webhook payloads into event rows (preview.ready / preview.failed).
 * Payload shape: { id, type, createdAt, payload: { deployment, project, target, url, links, ... } }.
 */
import type { NewEvent } from "@/lib/types";

type Json = Record<string, unknown>;

const get = <T = unknown>(obj: unknown, path: string): T | undefined =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj) as T | undefined;

export function normalizeVercel(body: Json): NewEvent | null {
  const type = get<string>(body, "type") ?? "";
  const id = get<string>(body, "id") ?? `${type}:${get(body, "createdAt") ?? Date.now()}`;
  if (type !== "deployment.succeeded" && type !== "deployment.ready" && type !== "deployment.error" && type !== "deployment.failed") return null;

  const p = get<Json>(body, "payload") ?? {};
  const meta = get<Json>(p, "deployment.meta") ?? {};
  const repoName = get<string>(meta, "githubRepo") ?? get<string>(meta, "gitlabProjectName");
  const org = get<string>(meta, "githubOrg") ?? get<string>(meta, "githubCommitOrg");
  const project = get<string>(p, "project.name") ?? repoName ?? null;
  const repo = org && repoName ? `${org}/${repoName}` : null;
  const ref = get<string>(meta, "githubCommitRef") ?? "";
  // a runner branch, either spelling: relay/<lane>-<issue> (run-lane.sh, job.ts) or the older relay/<issue>-<lane>
  const issueMatch = /^relay\/(?:[a-z][a-z0-9-]*-(\d+)|(\d+)-[a-z][a-z0-9-]*)(?:$|[-/])/.exec(ref);
  const issueFromRef = issueMatch ? Number(issueMatch[1] ?? issueMatch[2]) : null;
  const prId = get<string | number>(meta, "githubPrId");
  const target = get<string>(p, "target") ?? "preview";
  const host = get<string>(p, "url") ?? get<string>(p, "deployment.url");
  const ok = type === "deployment.succeeded" || type === "deployment.ready";
  const createdAt = get<number>(body, "createdAt");

  return {
    kind: ok ? "preview.ready" : "preview.failed",
    actor: "bot:vercel",
    project,
    repo,
    issue: Number.isInteger(issueFromRef) ? issueFromRef : null,
    pr: prId != null && prId !== "" ? Number(prId) : null,
    ts: createdAt ? new Date(createdAt).toISOString() : undefined,
    summary: ok
      ? `${target === "production" ? "Production" : "Preview"} deployed${prId ? ` for #${prId}` : ref ? ` for ${ref}` : ""}`
      : `${target === "production" ? "Production" : "Preview"} build failed${ref ? ` for ${ref}` : ""}`,
    url: ok ? (host ? `https://${host}` : null) : get<string>(p, "links.deployment") ?? null,
    // ref and commit let deriveTaskStatus match the deployment to a task when the issue number is not in the branch
    payload: { type, target, deployment_id: get(p, "deployment.id"), commit: get(meta, "githubCommitSha"), ref: ref || null, inspector: get<string>(p, "links.deployment") ?? null },
    dedupe_key: `vercel:${id}`,
  };
}
