/**
 * Event kinds the web app reads and the webhooks emit.
 *
 * The `events` table is append-only and `kind` is free text, so this file is the
 * documentation of what each kind means and where it comes from. Lanes (packages/core)
 * emit `run.*`, `step.usage`, `decision.*`, `memory.*`, `onboard.*`; the GitHub and
 * Vercel webhooks under app/api/webhooks emit the rest.
 */

export const EVENT_KINDS = {
  // GitHub webhook: issues
  "issue.opened": { group: "task", source: "github", label: "Issue opened", description: "A task entered the bus." },
  "issue.labeled": { group: "task", source: "github", label: "Lane assigned", description: "An agent:* label picked the lane." },
  "issue.closed": { group: "task", source: "github", label: "Issue closed", description: "The task is done or dropped." },
  // Runner lifecycle (also from GitHub workflow_run)
  "run.started": { group: "run", source: "runner", label: "Run started", description: "A runner claimed the job and checked out a fresh worktree." },
  "run.finished": { group: "run", source: "runner", label: "Run finished", description: "The CLI exited; payload has the exit status." },
  "run.failed": { group: "run", source: "runner", label: "Run failed", description: "The CLI exited non-zero or timed out." },
  "step.usage": { group: "usage", source: "lane", label: "Model call", description: "One headless CLI call with tokens, cache and cost equivalent. The ledger is a view over these." },
  // GitHub webhook: pull requests, reviews, CI
  "pr.opened": { group: "pr", source: "github", label: "PR opened", description: "The runner pushed a branch and opened the result." },
  "pr.review": { group: "pr", source: "github", label: "Review", description: "A review was submitted (approved, changes requested or commented)." },
  "pr.merged": { group: "pr", source: "github", label: "Merged", description: "The human accepted the result." },
  "pr.closed": { group: "pr", source: "github", label: "PR closed", description: "Closed without merge." },
  "workflow.run": { group: "ci", source: "github", label: "CI", description: "A GitHub Actions workflow run completed." },
  // Vercel webhook
  "preview.ready": { group: "deploy", source: "vercel", label: "Preview ready", description: "A deployment succeeded; url points at it." },
  "preview.failed": { group: "deploy", source: "vercel", label: "Preview failed", description: "A deployment errored." },
  // Memory
  "decision.captured": { group: "memory", source: "lane", label: "Decision", description: "A durable decision extracted from a session or a merged PR." },
  "preference.set": { group: "memory", source: "cli", label: "Preference", description: "A preference was set at global, project, lane or model scope." },
  "project.linked": { group: "memory", source: "cli", label: "Project linked", description: "relay link registered a repository." },
  "project.github_connected": { group: "memory", source: "github", label: "GitHub App installed", description: "The GitHub App was installed on a repository (auto-registered when it holds a relay.md)." },
  "project.github_disconnected": { group: "memory", source: "github", label: "GitHub App removed", description: "The GitHub App was removed from a repository or uninstalled." },
  // Access (docs/SECURITY.md, "Access for agents")
  "access.requested": { group: "access", source: "oauth", label: "Access requested", description: "A device or CLI asked for a token; payload carries the user code to approve at /activate or over the API." },
  "access.granted": { group: "access", source: "oauth", label: "Access granted", description: "A token was issued: consent, device approval or an invite redeemed." },
  "access.denied": { group: "access", source: "oauth", label: "Access denied", description: "A person declined a device request." },
  "access.revoked": { group: "access", source: "oauth", label: "Access revoked", description: "A token or refresh token was revoked, or a reused refresh token cut its lineage." },
  "memory.consolidated": { group: "memory", source: "nightly", label: "Memory consolidated", description: "Nightly digest: superseded decisions closed, rules file regenerated." },
  "onboard.refreshed": { group: "memory", source: "cli", label: "Vendor docs refreshed", description: "Official guidance and skills for a model were re-ingested." },
  // Assets (docs/ASSETS.md)
  "asset.uploaded": { group: "asset", source: "api", label: "Asset uploaded", description: "A new asset or version landed in the library and awaits review." },
  "asset.reviewed": { group: "asset", source: "web", label: "Asset reviewed", description: "A human approved or rejected an asset; a rejection note becomes a decision." },
  "asset.published": { group: "asset", source: "api", label: "Asset published", description: "An approved asset was copied to the public store; url is permanent." },
} as const;

export type EventKind = keyof typeof EVENT_KINDS;
export type EventGroup = (typeof EVENT_KINDS)[EventKind]["group"];

export const EVENT_KIND_LIST = Object.keys(EVENT_KINDS) as EventKind[];

export function isEventKind(value: string): value is EventKind {
  return value in EVENT_KINDS;
}

export function kindInfo(kind: string): { group: EventGroup | "other"; label: string; description: string } {
  if (isEventKind(kind)) return EVENT_KINDS[kind];
  return { group: "other", label: kind, description: "Unknown event kind." };
}

/** Actor strings are "<kind>:<name>", e.g. human:maya, bot:grok, runner:studio, agent:claude. */
export function parseActor(actor: string): { kind: "human" | "bot" | "runner" | "agent" | "other"; name: string } {
  const idx = actor.indexOf(":");
  if (idx < 0) return { kind: "other", name: actor };
  const kind = actor.slice(0, idx);
  const name = actor.slice(idx + 1);
  if (kind === "human" || kind === "bot" || kind === "runner" || kind === "agent") return { kind, name };
  return { kind: "other", name: actor };
}
