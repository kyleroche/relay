/**
 * Which relay project a GitHub delivery is about. One repository is usually one project, named after the repo; a
 * productions repo (issues only, one relay project per production, docs/PRODUCTIONS.md) is shared, so the issue says:
 * a `production:<slug>` label on the issue or PR names the project, else the repository's name. Pure.
 */

export interface ProjectHint {
  /** The `labels` array of the issue or PR in the payload, as GitHub sends it. */
  labels: unknown;
  /** `repository.name`, the fallback. */
  repoName: string | null;
}

const PRODUCTION_LABEL = /^production:([\w.-]{1,100})$/;

/** The slug a `production:<slug>` label among `labels` names, or null. */
export function productionFromLabels(labels: unknown): string | null {
  if (!Array.isArray(labels)) return null;
  for (const l of labels) {
    const name = typeof l === "string" ? l : l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? (l as { name: string }).name : undefined;
    const slug = PRODUCTION_LABEL.exec(name ?? "")?.[1];
    if (slug) return slug;
  }
  return null;
}

export const resolveProject = (hint: ProjectHint): string | null => productionFromLabels(hint.labels) ?? hint.repoName;
