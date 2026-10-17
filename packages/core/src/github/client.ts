/**
 * The small GitHub surface relay needs to open tasks: create an issue, add labels, read an issue, and a `request`
 * escape hatch for comments and state changes. Three ways in, all using a credential that already lives where the
 * code runs: a GitHub App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, installation tokens minted per repository in
 * github/app.ts), a token from the environment (`GITHUB_APP_TOKEN` or `GITHUB_TOKEN`), or the `gh` CLI's own login
 * (the CLI and the stdio MCP server). Nothing here stores or copies a credential.
 */
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { statSync } from "node:fs";
import { appConfigFromEnv, GitHubApp } from "./app.ts";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  labels: string[];
}

export interface GitHubPull {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  html_url: string;
  /** The head branch name and its current commit. */
  head_ref: string;
  head_sha: string;
  base_ref: string;
  /** GitHub login of whoever opened it. */
  user: string;
}

export interface MergeOptions {
  method?: "squash" | "merge" | "rebase";
  /** Commit title (squash and merge methods). */
  title?: string;
  /** Commit body. */
  message?: string;
  /** Refuse to merge unless the head is still at this sha. */
  sha?: string;
}

export interface MergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export interface GitHubClient {
  /** How this client authenticates; printed by `relay doctor`, never the credential itself. */
  readonly source: "app" | "token" | "gh";
  createIssue(repo: string, input: { title: string; body: string; labels?: string[] }): Promise<GitHubIssue>;
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  getIssue(repo: string, issue: number): Promise<GitHubIssue>;
  /** Any REST call under /repos/{owner}/{repo}/… (comments, reopening an issue). Throws GitHubError on non-2xx. */
  request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  /** Comment on an issue or pull request (the cloud-lane dispatch comment). */
  createComment(repo: string, issue: number, body: string): Promise<{ id: number; html_url: string }>;
  /** One pull request with its head branch and sha (the review step reads it before merging). */
  getPullRequest(repo: string, number: number): Promise<GitHubPull>;
  /** Merge a pull request (squash by default). Throws GitHubError with GitHub's message (405 not mergeable, 409 head moved). */
  mergePullRequest(repo: string, number: number, opts?: MergeOptions): Promise<MergeResult>;
  /** Delete a branch (`refs/heads/<ref>`); a branch that is already gone is not an error. */
  deleteBranch(repo: string, ref: string): Promise<void>;
}

const toComment = (j: Record<string, unknown>): { id: number; html_url: string } => ({ id: Number(j.id ?? 0), html_url: String(j.html_url ?? "") });

export function toPull(j: Record<string, unknown>): GitHubPull {
  const head = (j.head ?? {}) as Record<string, unknown>;
  const base = (j.base ?? {}) as Record<string, unknown>;
  const user = (j.user ?? {}) as Record<string, unknown>;
  return {
    number: Number(j.number),
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    merged: Boolean(j.merged),
    html_url: String(j.html_url ?? ""),
    head_ref: String(head.ref ?? ""),
    head_sha: String(head.sha ?? ""),
    base_ref: String(base.ref ?? ""),
    user: String(user.login ?? ""),
  };
}

const toMerge = (j: Record<string, unknown>): MergeResult => ({ sha: String(j.sha ?? ""), merged: Boolean(j.merged), message: String(j.message ?? "") });

const mergeBody = (o: MergeOptions): Record<string, unknown> => ({
  merge_method: o.method ?? "squash",
  ...(o.title ? { commit_title: o.title } : {}),
  ...(o.message ? { commit_message: o.message } : {}),
  ...(o.sha ? { sha: o.sha } : {}),
});

/** Shared by the token and gh clients: the three pull-request calls over a raw `call(method, path, body)`. */
function pullOps(call: (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>): Pick<GitHubClient, "getPullRequest" | "mergePullRequest" | "deleteBranch"> {
  return {
    async getPullRequest(repo, number) {
      assertRepo(repo);
      return toPull(await call("GET", `/repos/${repo}/pulls/${number}`));
    },
    async mergePullRequest(repo, number, opts = {}) {
      assertRepo(repo);
      return toMerge(await call("PUT", `/repos/${repo}/pulls/${number}/merge`, mergeBody(opts)));
    },
    async deleteBranch(repo, ref) {
      assertRepo(repo);
      const name = ref.replace(/^refs\/heads\//, "");
      if (!name || /[\s~^:?*[\\]/.test(name)) throw new GitHubError(`branch name is not valid: ${ref}`);
      try {
        await call("DELETE", `/repos/${repo}/git/refs/heads/${name}`);
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 404 || e.status === 422)) return; // already gone
        throw e;
      }
    },
  };
}

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GitHubError";
  }
}

const API = "https://api.github.com";

function toIssue(j: Record<string, unknown>): GitHubIssue {
  const labels = Array.isArray(j.labels) ? (j.labels as Array<string | { name?: string }>).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean) : [];
  return { number: Number(j.number), title: String(j.title ?? ""), body: typeof j.body === "string" ? j.body : "", state: String(j.state ?? ""), html_url: String(j.html_url ?? ""), labels };
}

export function assertRepo(repo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError(`repo must be owner/name (got ${repo})`);
}

export type GitHubFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** REST client over a bearer token (a fine-grained token with issues:write on the managed repos, or an installation token). */
export function githubFromToken(token: string, fetchImpl: GitHubFetch = (u, i) => fetch(u, i), apiUrl: string = API): GitHubClient {
  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "relay", "x-github-api-version": "2022-11-28" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${path}: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`, res.status);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  return {
    source: "token",
    async createIssue(repo, input) {
      assertRepo(repo);
      return toIssue(await call("POST", `/repos/${repo}/issues`, { title: input.title, body: input.body, ...(input.labels?.length ? { labels: input.labels } : {}) }));
    },
    async addLabels(repo, issue, labels) {
      assertRepo(repo);
      if (!labels.length) return;
      await call("POST", `/repos/${repo}/issues/${issue}/labels`, { labels });
    },
    async getIssue(repo, issue) {
      assertRepo(repo);
      return toIssue(await call("GET", `/repos/${repo}/issues/${issue}`));
    },
    request: (method, path, body) => call(method, path, body),
    async createComment(repo, issue, body) {
      assertRepo(repo);
      return toComment(await call("POST", `/repos/${repo}/issues/${issue}/comments`, { body }));
    },
    ...pullOps(call),
  };
}

let envApp: { key: string; app: GitHubApp } | undefined;

/** The GitHub App the environment configures, constructed once so its token caches survive across calls. */
export function appFromEnv(env: Record<string, string | undefined> = process.env): GitHubApp | undefined {
  const cfg = appConfigFromEnv(env);
  if (!cfg) return undefined;
  const key = `${cfg.appId}:${cfg.privateKey.length}:${cfg.apiUrl ?? ""}`;
  if (!envApp || envApp.key !== key) envApp = { key, app: new GitHubApp(cfg) };
  return envApp.app;
}

export function findOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** `gh api` client: the machine's own gh login does the calls; relay never sees the token. */
export function githubFromGh(bin: string = findOnPath("gh") ?? "gh"): GitHubClient {
  const api = (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
      if (body !== undefined) args.push("--input", "-");
      const child = execFile(bin, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
        if (err) {
          const first = (stderr || err.message).toString().split("\n")[0] ?? "";
          const status = /HTTP (\d{3})/.exec(first)?.[1];
          return rej(new GitHubError(`gh api ${method} ${path} failed: ${first.slice(0, 200)}`, status ? Number(status) : undefined));
        }
        try {
          res(stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {});
        } catch (e) {
          rej(new GitHubError(`gh api ${method} ${path}: unreadable response (${e instanceof Error ? e.message : String(e)})`));
        }
      });
      if (body !== undefined) child.stdin?.end(JSON.stringify(body));
    });
  return {
    source: "gh",
    async createIssue(repo, input) {
      assertRepo(repo);
      return toIssue(await api("POST", `/repos/${repo}/issues`, { title: input.title, body: input.body, ...(input.labels?.length ? { labels: input.labels } : {}) }));
    },
    async addLabels(repo, issue, labels) {
      assertRepo(repo);
      if (!labels.length) return;
      await api("POST", `/repos/${repo}/issues/${issue}/labels`, { labels });
    },
    async getIssue(repo, issue) {
      assertRepo(repo);
      return toIssue(await api("GET", `/repos/${repo}/issues/${issue}`));
    },
    request: (method, path, body) => api(method, path, body),
    async createComment(repo, issue, body) {
      assertRepo(repo);
      return toComment(await api("POST", `/repos/${repo}/issues/${issue}/comments`, { body }));
    },
    ...pullOps(api),
  };
}

/**
 * The GitHub App when configured (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, or an `app` the caller resolved from its
 * settings), else a token from the environment, else the gh CLI; undefined when none is available.
 */
export function detectGitHub(env: Record<string, string | undefined> = process.env, opts: { allowGh?: boolean; app?: GitHubClient } = {}): GitHubClient | undefined {
  if (opts.app) return opts.app;
  const app = appFromEnv(env);
  if (app) return app.client();
  const token = env.GITHUB_APP_TOKEN || env.GITHUB_TOKEN;
  if (token) return githubFromToken(token, undefined, env.GITHUB_API_URL?.replace(/\/$/, "") || API);
  if (opts.allowGh !== false) {
    const gh = findOnPath("gh");
    if (gh) return githubFromGh(gh);
  }
  return undefined;
}
