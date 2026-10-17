/**
 * The `events` check `relay link` prints as a stage and `relay doctor` prints per project: will GitHub events for a
 * linked repo (issues, labels, PRs, deployment statuses) reach the site? One wording for both, so the user reads the
 * same sentence wherever it comes up. Nothing here fails a command; the answer is advice.
 */
import type { GitHubStatus, RelayClient } from "@relay/core";
import type { Check } from "./probes.ts";

export const EVENTS_CHECK = "events";

/** The one line for a project's GitHub status on `site`. */
export function eventsCheck(s: GitHubStatus, site: string): Check {
  const repoName = s.repo ?? "this repo";
  if (!s.app.configured) return { status: "warn", name: EVENTS_CHECK, detail: `${site} has no GitHub App configured; the operator sets it up at ${site}/setup/github` };
  if (s.app.installed) return { status: "ok", name: EVENTS_CHECK, detail: `GitHub App installed on ${repoName} (installation ${s.app.installation_id})` };
  if (s.app.error) return { status: "warn", name: EVENTS_CHECK, detail: `could not check the GitHub App on ${repoName}: ${s.app.error}` };
  return { status: "warn", name: EVENTS_CHECK, detail: `GitHub App not installed on ${repoName}: install it once at ${s.app.install_url} (covers every repo you pick); until then issues, labels, PRs and previews from this repo do not reach ${site}` };
}

/** A stage line `relay link` prints: doctor's statuses plus `info` for a fact that needs no action. */
export interface StageLine {
  status: Check["status"] | "info";
  name: string;
  detail: string;
}

/** The line for a CLI without a site: nothing ingests GitHub events here. */
export const localEventsCheck = (): StageLine => ({ status: "info", name: EVENTS_CHECK, detail: "local mode: GitHub events are not ingested; join a site with relay setup --site" });

/** `ok    events   ...`: the stage line as `relay link` logs it (doctor's column layout). */
export const formatStage = (c: StageLine): string => `${c.status.padEnd(5)} ${c.name.padEnd(8)} ${c.detail}`;

/** What is left to do after everything else is linked, or undefined when nothing is. */
export function eventsLeft(s: GitHubStatus, site: string): string | undefined {
  if (!s.app.configured) return `ask the operator to configure the GitHub App at ${site}/setup/github; until then GitHub events from this repo do not reach ${site}`;
  if (!s.app.installed && !s.app.error) return `install the GitHub App on ${s.repo ?? "this repo"} at ${s.app.install_url}; until then GitHub events from this repo do not reach ${site}`;
  return undefined;
}

export interface ProjectsEventsReport {
  checks: Check[];
  /** Projects checked (those with a repo). */
  checked: number;
}

/**
 * `relay doctor` in site mode: one line per linked project whose repo the App is not installed on, capped at `cap`
 * lines then "+N more"; a single line when the site has no App at all. Silent when every project is covered.
 */
export async function projectsEventsReport(client: RelayClient, site: string, cap = 5): Promise<ProjectsEventsReport> {
  const projects = (await client.listProjects()).filter((p) => p.repo);
  const missing: Check[] = [];
  let checked = 0;
  for (const p of projects) {
    const s = await client.githubStatus(p.slug).catch(() => undefined);
    if (!s) continue;
    checked++;
    if (!s.app.configured) return { checks: [eventsCheck(s, site)], checked };
    if (!s.app.installed) missing.push(eventsCheck(s, site));
  }
  const shown = missing.slice(0, cap);
  if (missing.length > cap) shown.push({ status: "warn", name: EVENTS_CHECK, detail: `+${missing.length - cap} more linked repos without the GitHub App; relay link in each prints the install link` });
  return { checks: shown, checked };
}
