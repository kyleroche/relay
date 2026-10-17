/**
 * Will GitHub events for a project's repository reach this site? The answer `relay link` and `relay doctor` print
 * (`GET /api/v1/projects/{slug}/github`, `RelayClient.githubStatus`). Pure over its inputs so the route stays thin and
 * the logic is testable with a fake GitHub: the App (or none), the App's slug, this site's URL and the delivery
 * statistics the database holds for the repo.
 */
import { GitHubError, type GitHubApp, type GitHubStatus, type repo } from "@relay/core";

type GitHubDeliveryStats = repo.GitHubDeliveryStats;

export interface GitHubStatusDeps {
  /** The GitHub App this site acts as; undefined when none is configured. */
  app?: GitHubApp | undefined;
  /** The App's slug when known (makes `install_url` the App's own install page). */
  slug?: string | null;
  /** This site's public URL; `install_url` points at its /setup/github when no App exists. */
  siteUrl: string;
  /** GitHub deliveries already recorded for the repo; omit when the store cannot say (mock mode). */
  delivery?: GitHubDeliveryStats | undefined;
}

export async function githubStatusFor(repoName: string | null, deps: GitHubStatusDeps): Promise<GitHubStatus> {
  const app = deps.app;
  const out: GitHubStatus = {
    repo: repoName,
    app: { configured: !!app, slug: app ? (deps.slug ?? app.cfg.slug ?? null) : null, installed: false, installation_id: null, install_url: app ? app.installUrl() : `${deps.siteUrl}/setup/github` },
  };
  if (app && repoName) {
    try {
      out.app.installation_id = await app.installationFor(repoName);
      out.app.installed = true;
    } catch (e) {
      // 404 is GitHub's answer for "not installed here"; anything else means the check itself failed
      if (!(e instanceof GitHubError && e.status === 404)) out.app.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (deps.delivery) out.webhook = { org_or_repo_hook_seen: deps.delivery.count > 0, last_delivery_at: deps.delivery.last_delivery_at };
  return out;
}
