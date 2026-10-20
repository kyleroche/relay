/**
 * Which relay project a GitHub delivery is about. One repository is usually one project, named after the repo; a
 * productions repo (issues only, one relay project per production, docs/ARCHITECTURE.md "A task's life") is shared,
 * so the issue says: the task row relay opened for it names the project, else a `production:<slug>` label on the
 * issue or PR (openTask adds one on a shared repo), else the repository's name as before. Pure apart from the
 * `lookup`, which the route binds to `getTask` in db mode and to nothing in mock mode.
 */
import { productionOf } from "@relay/core";

export interface ProjectHint {
  /** owner/name of the delivery's repository, or null. */
  repo: string | null;
  /** The issue number the delivery is about (an issue, or the issue a PR closes), or null. */
  issue: number | null;
  /** The `labels` array of the issue or PR in the payload, as GitHub sends it. */
  labels: unknown;
  /** `repository.name`, the fallback. */
  repoName: string | null;
}

/** The project of the task row for (repo, issue), when relay tracks one; null or undefined otherwise. */
export type TaskProjectLookup = (repo: string, issue: number) => Promise<string | null | undefined>;

/** The slug a `production:<slug>` label among `labels` names, or null. */
export function productionFromLabels(labels: unknown): string | null {
  if (!Array.isArray(labels)) return null;
  for (const l of labels) {
    const name = typeof l === "string" ? l : l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? (l as { name: string }).name : undefined;
    const slug = productionOf(name);
    if (slug) return slug;
  }
  return null;
}

export async function resolveProject(hint: ProjectHint, lookup?: TaskProjectLookup): Promise<string | null> {
  if (hint.repo && hint.issue != null && lookup) {
    try {
      const fromTask = await lookup(hint.repo, hint.issue);
      if (fromTask) return fromTask;
    } catch {
      /* the store is the route's problem; fall through to what the payload says */
    }
  }
  return productionFromLabels(hint.labels) ?? hint.repoName;
}
