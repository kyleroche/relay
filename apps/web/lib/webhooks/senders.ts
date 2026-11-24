/**
 * Who may open a task from GitHub. An `agent:<lane>` label makes a worker spend a subscription on whatever the issue
 * says, so only an allowlisted login may add one that counts, and an unset allowlist refuses everyone.
 *
 * The allowlist is RELAY_ALLOWED_SENDERS (env, comma-separated), else the repository's Actions variable of the same
 * name, read through the GitHub API with GITHUB_APP_TOKEN or GITHUB_TOKEN and cached an hour.
 */

declare global {
  // eslint-disable-next-line no-var
  var __relaySenders: Map<string, { at: number; logins: Set<string> | null }> | undefined;
}
const cache = (globalThis.__relaySenders ??= new Map());
const HOUR = 3_600_000;

/** The configured allowlist as lower-cased logins, or null when neither the environment nor the repo variable sets one. */
async function allowedSenders(repo: string | null): Promise<Set<string> | null> {
  const env = process.env.RELAY_ALLOWED_SENDERS;
  if (env?.trim()) return new Set(env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const token = process.env.GITHUB_APP_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || !repo) return null;
  const hit = cache.get(repo);
  if (!hit || Date.now() - hit.at > HOUR) {
    let logins: Set<string> | null = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/variables/RELAY_ALLOWED_SENDERS`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "relay-web", "x-github-api-version": "2022-11-28" },
      });
      if (res.ok) {
        const j = (await res.json()) as { value?: string };
        logins = new Set((j.value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
      }
    } catch {
      /* unreachable: no allowlist for now, and retry next hour */
    }
    cache.set(repo, { at: Date.now(), logins });
  }
  return cache.get(repo)?.logins ?? null;
}

/** True when the login may turn an `agent:<lane>` label into a task a worker will run. No allowlist refuses everyone. */
export async function senderMayOpenTasks(repo: string | null, login: string): Promise<boolean> {
  const logins = await allowedSenders(repo);
  return !!logins && logins.has(login.toLowerCase());
}
