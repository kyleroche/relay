/**
 * A project's profile as the site knows it: `.relay/project.json` on the repository's default branch, read through
 * the site's GitHub client and parsed by core (`readProfile`). The default branch only, as on a worker, so what a
 * page offers to grant is what a job would be given. Kept five minutes per repository and instance: a profile changes
 * with a merged pull request, and the task page and every card of that project ask for it.
 *
 * In mock mode the profiles are the demo's (lib/mock.ts).
 */
import { EMPTY_PROFILE, GitHubError, PROFILE_PATH, readProfile, type GitHubClient, type ProjectProfile } from "@relay/core";
import { siteGitHub } from "./integrations.ts";
import { MOCK_PROFILES, MOCK_PROJECTS } from "./mock.ts";
import { dataMode } from "./mode.ts";

export interface ProfileRead {
  /** Undefined when the profile could not be read at all: nobody knows what it says. */
  profile: ProjectProfile | undefined;
  /** One line for the page when there is nothing to show, or the file's own problems. */
  why?: string;
}

const TTL_MS = 5 * 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __relayProfiles: Map<string, { at: number; read: Promise<ProfileRead> }> | undefined;
}

/** The profile in a file's text, with what the file got wrong as the one line. */
export function parseProfile(repo: string, text: string): ProfileRead {
  const profile = readProfile({ list: () => [], read: (path) => (path === PROFILE_PATH ? text : undefined), label: (path) => `${repo}:${path}` });
  return { profile, ...(profile.problems.length ? { why: profile.problems.join("; ") } : {}) };
}

/** One read of the file from GitHub. A repository without the file has the empty profile; any other failure is no profile. */
export async function fetchProfile(github: GitHubClient, repo: string): Promise<ProfileRead> {
  let file: Record<string, unknown>;
  try {
    file = await github.request("GET", `/repos/${repo}/contents/${PROFILE_PATH}`);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return { profile: { ...EMPTY_PROFILE, sets: {} }, why: `${repo} has no ${PROFILE_PATH} on its default branch, so it defines no capability sets.` };
    return { profile: undefined, why: `GitHub could not read ${PROFILE_PATH} of ${repo}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  if (typeof file.content !== "string" || file.encoding !== "base64") return { profile: undefined, why: `${PROFILE_PATH} of ${repo} is not a file GitHub returns as text.` };
  return parseProfile(repo, Buffer.from(file.content, "base64").toString("utf8"));
}

/** The profile of the project that works in `repo`. */
export function projectProfile(repo: string | null, now: number = Date.now()): Promise<ProfileRead> {
  if (!repo) return Promise.resolve({ profile: undefined, why: "This task names no repository, so there is no profile to read." });
  if (dataMode() !== "db") {
    const demo = MOCK_PROFILES[MOCK_PROJECTS.find((p) => p.repo === repo)?.slug ?? ""];
    return Promise.resolve(demo ? parseProfile(repo, JSON.stringify(demo)) : { profile: { ...EMPTY_PROFILE, sets: {} }, why: `${repo} has no ${PROFILE_PATH} on its default branch, so it defines no capability sets.` });
  }
  const cache = (globalThis.__relayProfiles ??= new Map());
  const hit = cache.get(repo);
  if (hit && now - hit.at < TTL_MS) return hit.read;
  const read = siteGitHub()
    .then((github): ProfileRead | Promise<ProfileRead> => (github ? fetchProfile(github, repo) : { profile: undefined, why: "GitHub is not connected, so the project's profile cannot be read (GitHub App, in the avatar menu)." }))
    .catch((e: unknown): ProfileRead => ({ profile: undefined, why: `The project's profile could not be read: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }))
    .then((r) => {
      // a failure is asked again on the next render; only an answer is kept
      if (!r.profile && cache.get(repo)?.read === read) cache.delete(repo);
      return r;
    });
  cache.set(repo, { at: now, read });
  return read;
}
