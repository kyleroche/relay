/**
 * GitHub App credentials instead of a personal token (docs/HOSTING.md, "GitHub App"). The app's private key signs a
 * short-lived RS256 JWT (jose); that JWT mints installation access tokens (one hour) which are cached per installation
 * and refreshed a minute before they expire. The installation for a repository is discovered with
 * `GET /repos/{owner}/{repo}/installation` and cached too. Nothing here persists a token anywhere but memory.
 *
 * Environment: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (PEM; literal `\n` sequences are accepted so the key fits in
 * one Vercel variable). The web app may also read the pair from its sealed `settings` table; the environment wins.
 */
import { importPKCS8, SignJWT } from "jose";
import { assertRepo, GitHubError, githubFromToken, type GitHubClient, type GitHubFetch, type GitHubIssue } from "./client.ts";

export interface GitHubAppConfig {
  appId: string;
  /** PKCS#8 or PKCS#1 PEM. GitHub issues PKCS#1 (`BEGIN RSA PRIVATE KEY`); both are accepted. */
  privateKey: string;
  apiUrl?: string;
  /** The app's slug, when known (links to the install page). */
  slug?: string;
}

export const APP_JWT_TTL_SECONDS = 9 * 60;
const REFRESH_MARGIN_MS = 60_000;

/** Normalise a key pasted into an environment variable: `\n` escapes, surrounding quotes, CRLF. */
export function normalizePem(raw: string): string {
  let pem = raw.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) pem = pem.slice(1, -1);
  pem = pem.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    // base64 of the PEM itself, the other common way to fit it in one line
    try {
      const decoded = Buffer.from(pem, "base64").toString("utf8").trim();
      if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(decoded)) pem = decoded;
    } catch {
      /* leave as is; importing will fail with a clear message */
    }
  }
  return pem + "\n";
}

export function appConfigFromEnv(env: Record<string, string | undefined> = process.env): GitHubAppConfig | undefined {
  const appId = env.GITHUB_APP_ID?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !key?.trim()) return undefined;
  const out: GitHubAppConfig = { appId, privateKey: normalizePem(key) };
  if (env.GITHUB_API_URL) out.apiUrl = env.GITHUB_API_URL.replace(/\/$/, "");
  if (env.GITHUB_APP_SLUG) out.slug = env.GITHUB_APP_SLUG;
  return out;
}

/** PKCS#1 → PKCS#8 so jose can import what GitHub hands out. */
async function importKey(pem: string): Promise<CryptoKey> {
  const { createPrivateKey } = await import("node:crypto");
  const pkcs8 = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  return importPKCS8(pkcs8, "RS256");
}

/** The app JWT GitHub wants for app-level calls: iss = app id, iat 60 s in the past (clock skew), exp ≤ 10 minutes. */
export async function appJwt(cfg: GitHubAppConfig, now: number = Date.now()): Promise<string> {
  const key = await importKey(cfg.privateKey);
  const iat = Math.floor(now / 1000) - 60;
  return new SignJWT({}).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(String(cfg.appId)).setIssuedAt(iat).setExpirationTime(iat + 60 + APP_JWT_TTL_SECONDS).sign(key);
}

export interface InstallationInfo {
  id: number;
  account: string;
  account_type: string;
  repository_selection: "all" | "selected" | string;
  html_url: string;
  created_at: string;
  suspended_at: string | null;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface GitHubAppOptions {
  fetch?: GitHubFetch;
  now?: () => number;
}

/** One app, its JWT, and the installation tokens it mints. Construct once per process and reuse (the caches live here). */
export class GitHubApp {
  readonly api: string;
  /** The fetch this app calls GitHub with (injectable for tests). */
  readonly doFetch: GitHubFetch;
  private readonly now: () => number;
  private readonly tokens = new Map<number, CachedToken>();
  private readonly installations = new Map<string, { id: number; at: number }>();
  private jwtCache: { token: string; expiresAt: number } | undefined;

  constructor(
    readonly cfg: GitHubAppConfig,
    opts: GitHubAppOptions = {},
  ) {
    this.api = (cfg.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
  }

  /** A JWT with at least two minutes left, minted anew otherwise. */
  async jwt(): Promise<string> {
    const now = this.now();
    if (this.jwtCache && this.jwtCache.expiresAt - now > 120_000) return this.jwtCache.token;
    const token = await appJwt(this.cfg, now);
    this.jwtCache = { token, expiresAt: now + APP_JWT_TTL_SECONDS * 1000 };
    return token;
  }

  private async call(auth: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.doFetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "relay", "x-github-api-version": "2022-11-28" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${path}: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`, res.status);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  /** App-level call (authenticated with the JWT): installations, the app itself. */
  async appRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    return this.call(await this.jwt(), method, path, body);
  }

  /** Who installed the app, for the setup page. */
  async listInstallations(): Promise<InstallationInfo[]> {
    const raw = (await this.appRequest("GET", "/app/installations?per_page=100")) as unknown;
    const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    return list.map((i) => ({
      id: Number(i.id),
      account: String((i.account as Record<string, unknown> | undefined)?.login ?? ""),
      account_type: String((i.account as Record<string, unknown> | undefined)?.type ?? ""),
      repository_selection: String(i.repository_selection ?? ""),
      html_url: String(i.html_url ?? ""),
      created_at: String(i.created_at ?? ""),
      suspended_at: (i.suspended_at as string | null) ?? null,
    }));
  }

  /** The installation that covers `owner/name`; cached for an hour. 404 means the app is not installed there. */
  async installationFor(repo: string): Promise<number> {
    assertRepo(repo);
    const hit = this.installations.get(repo);
    if (hit && this.now() - hit.at < 3_600_000) return hit.id;
    let j: Record<string, unknown>;
    try {
      j = await this.appRequest("GET", `/repos/${repo}/installation`);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new GitHubError(`The GitHub App is not installed on ${repo}. Install it from ${this.installUrl()} and include that repository.`, 404);
      throw e;
    }
    const id = Number(j.id);
    if (!Number.isFinite(id)) throw new GitHubError(`GitHub returned no installation id for ${repo}.`);
    this.installations.set(repo, { id, at: this.now() });
    return id;
  }

  /** An installation access token, minted or from cache, valid for at least a minute. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - this.now() > REFRESH_MARGIN_MS) return cached.token;
    const j = await this.appRequest("POST", `/app/installations/${installationId}/access_tokens`);
    const token = typeof j.token === "string" ? j.token : undefined;
    if (!token) throw new GitHubError("GitHub returned no installation token.");
    const expiresAt = typeof j.expires_at === "string" ? new Date(j.expires_at).getTime() : this.now() + 3_600_000;
    this.tokens.set(installationId, { token, expiresAt });
    return token;
  }

  /** Token for whichever installation covers the repo. */
  async tokenFor(repo: string): Promise<string> {
    return this.installationToken(await this.installationFor(repo));
  }

  installUrl(): string {
    return this.cfg.slug ? `https://github.com/apps/${this.cfg.slug}/installations/new` : "https://github.com/settings/installations";
  }

  /** Forget cached tokens (tests, or after an installation is removed). */
  reset(): void {
    this.tokens.clear();
    this.installations.clear();
    this.jwtCache = undefined;
  }

  /** A GitHubClient that picks the installation per repository. */
  client(): GitHubClient {
    const perRepo = (repo: string) => this.tokenFor(repo).then((t) => githubFromToken(t, this.doFetch, this.api));
    const repoOfPath = (path: string): string => {
      const m = /^\/repos\/([\w.-]+\/[\w.-]+)(?:\/|$)/.exec(path);
      if (!m) throw new GitHubError(`An installation token is scoped to a repository; the path ${path} names none.`);
      return m[1]!;
    };
    return {
      source: "app",
      createIssue: async (repo, input): Promise<GitHubIssue> => (await perRepo(repo)).createIssue(repo, input),
      addLabels: async (repo, issue, labels) => (await perRepo(repo)).addLabels(repo, issue, labels),
      removeLabel: async (repo, issue, label) => (await perRepo(repo)).removeLabel(repo, issue, label),
      ensureLabel: async (repo, label) => (await perRepo(repo)).ensureLabel!(repo, label),
      getIssue: async (repo, issue) => (await perRepo(repo)).getIssue(repo, issue),
      createComment: async (repo, issue, body) => (await perRepo(repo)).createComment(repo, issue, body),
      getPullRequest: async (repo, number) => (await perRepo(repo)).getPullRequest(repo, number),
      mergePullRequest: async (repo, number, o) => (await perRepo(repo)).mergePullRequest(repo, number, o),
      deleteBranch: async (repo, ref) => (await perRepo(repo)).deleteBranch(repo, ref),
      request: async (method, path, body) => (await perRepo(repoOfPath(path))).request(method, path, body),
    };
  }
}

/** True when the app is installed on the repo and `relay.md` exists at its root (the auto-register rule). */
export async function repoHasRelayFile(app: GitHubApp, repo: string, installationId?: number): Promise<boolean> {
  try {
    const token = installationId ? await app.installationToken(installationId) : await app.tokenFor(repo);
    const client = githubFromToken(token, app.doFetch, app.api);
    await client.request("GET", `/repos/${repo}/contents/relay.md`);
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}
