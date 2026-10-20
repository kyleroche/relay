/**
 * GitHub App deliveries that are about the app itself: `installation` (created, deleted, suspend, unsuspend) and
 * `installation_repositories` (added, removed). Each repository becomes one `project.github_connected` or
 * `project.github_disconnected` row. A connected repository is registered as a project by its name only when it
 * already holds a `relay.md` (so `relay link` ran there); otherwise relay only logs it and waits.
 */
import { repo, repoHasRelayFile, type Db, type GitHubApp } from "@relay/core";
import type { NewEvent } from "@/lib/types";

type Json = Record<string, unknown>;

const get = <T = unknown>(obj: unknown, path: string): T | undefined =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj) as T | undefined;

interface RepoRef {
  full_name: string;
  name: string;
}

function repos(list: unknown): RepoRef[] {
  if (!Array.isArray(list)) return [];
  return list.map((r) => ({ full_name: String(get(r, "full_name") ?? ""), name: String(get(r, "name") ?? "") })).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r.full_name));
}

export function isInstallationEvent(eventName: string): boolean {
  return eventName === "installation" || eventName === "installation_repositories";
}

export interface InstallationOutcome {
  events: NewEvent[];
  registered: string[];
}

/**
 * Turn an installation delivery into feed rows (and project rows when allowed). `app` is used to look for relay.md
 * with the installation's own token; without an app configured nothing is registered.
 */
export async function installationEvents(eventName: string, payload: Json, deliveryId: string, deps: { db: Db; app?: GitHubApp | undefined }): Promise<InstallationOutcome> {
  const action = get<string>(payload, "action") ?? "";
  const installationId = Number(get(payload, "installation.id"));
  const account = get<string>(payload, "installation.account.login") ?? "unknown";
  const sender = get<string>(payload, "sender.login") ?? account;
  const actor = `human:${sender}`;
  const out: InstallationOutcome = { events: [], registered: [] };

  let connected: RepoRef[] = [];
  let disconnected: RepoRef[] = [];
  if (eventName === "installation") {
    if (action === "created" || action === "unsuspend" || action === "new_permissions_accepted") connected = repos(payload.repositories);
    else if (action === "deleted" || action === "suspend") disconnected = repos(payload.repositories);
  } else if (eventName === "installation_repositories") {
    connected = repos(payload.repositories_added);
    disconnected = repos(payload.repositories_removed);
  }
  if (!connected.length && !disconnected.length) {
    if (eventName === "installation") {
      out.events.push({ kind: action === "deleted" || action === "suspend" ? "project.github_disconnected" : "project.github_connected", actor, project: null, repo: null, summary: `GitHub App ${action} for ${account}`, url: get<string>(payload, "installation.html_url") ?? null, payload: { action, installation_id: installationId, account }, dedupe_key: `github:${deliveryId}` });
    }
    return out;
  }

  // one slug per repo; when several projects share one (a productions repo) the one named after the repo stands for it
  const existing = new Map<string, string>();
  for (const p of await repo.listProjects(deps.db)) {
    if (!p.repo) continue;
    const key = p.repo.toLowerCase();
    if (!existing.has(key) || p.slug.toLowerCase() === key.split("/")[1]) existing.set(key, p.slug);
  }

  for (const r of connected) {
    let slug = existing.get(r.full_name.toLowerCase()) ?? null;
    let registered = false;
    if (!slug && deps.app && Number.isFinite(installationId)) {
      try {
        if (await repoHasRelayFile(deps.app, r.full_name, installationId)) {
          const taken = await repo.getProject(deps.db, r.name);
          if (!taken || !taken.repo || taken.repo.toLowerCase() === r.full_name.toLowerCase()) {
            await repo.upsertProject(deps.db, { slug: r.name, repo: r.full_name });
            slug = r.name;
            registered = true;
            out.registered.push(r.name);
          }
        }
      } catch (e) {
        console.error(`[relay] relay.md probe for ${r.full_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.events.push({
      kind: "project.github_connected",
      actor,
      project: slug,
      repo: r.full_name,
      summary: registered ? `GitHub App installed on ${r.full_name}; registered project ${slug} (relay.md present)` : slug ? `GitHub App installed on ${r.full_name} (project ${slug})` : `GitHub App installed on ${r.full_name}; run relay link there to register it`,
      url: `https://github.com/${r.full_name}`,
      payload: { action, installation_id: installationId, account, registered, has_project: !!slug },
      dedupe_key: `github:${deliveryId}:${r.full_name}:connected`,
    });
  }
  for (const r of disconnected) {
    const slug = existing.get(r.full_name.toLowerCase()) ?? null;
    out.events.push({
      kind: "project.github_disconnected",
      actor,
      project: slug,
      repo: r.full_name,
      summary: `GitHub App removed from ${r.full_name}${slug ? ` (project ${slug} keeps its memory)` : ""}`,
      url: `https://github.com/${r.full_name}`,
      payload: { action, installation_id: installationId, account },
      dedupe_key: `github:${deliveryId}:${r.full_name}:disconnected`,
    });
  }
  return out;
}
