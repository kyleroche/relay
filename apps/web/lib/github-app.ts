/**
 * The GitHub App this site acts as (docs/HOSTING.md, "GitHub App"). Two sources, the environment first:
 *
 *   1. GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (+ GITHUB_APP_SLUG, GITHUB_WEBHOOK_SECRET)   set in Vercel by hand
 *   2. the `settings` table, written by the manifest flow on /setup/github                 id and slug plain,
 *      private key, webhook secret and client secret sealed under RELAY_SESSION_SECRET
 *
 * Rotating: set the new values in the environment (they win at once), or delete the stored app on /setup/github and
 * run the manifest flow again. Rotating RELAY_SESSION_SECRET makes the sealed values unreadable, which this module
 * reports as "not configured" rather than failing calls.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfigFromEnv, GitHubApp, repo, type GitHubAppConfig } from "@relay/core";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { SITE_URL } from "@/lib/site";

export const SETTINGS_PREFIX = "github_app.";
const KEYS = {
  id: `${SETTINGS_PREFIX}id`,
  slug: `${SETTINGS_PREFIX}slug`,
  html_url: `${SETTINGS_PREFIX}html_url`,
  owner: `${SETTINGS_PREFIX}owner`,
  private_key: `${SETTINGS_PREFIX}private_key`,
  webhook_secret: `${SETTINGS_PREFIX}webhook_secret`,
  client_id: `${SETTINGS_PREFIX}client_id`,
  client_secret: `${SETTINGS_PREFIX}client_secret`,
} as const;

export interface ResolvedGitHubApp {
  config: GitHubAppConfig;
  source: "env" | "settings";
  slug: string | null;
  htmlUrl: string | null;
  owner: string | null;
  webhookSecret: string | null;
}

/** The app configuration in force, or undefined. Environment first, then the sealed settings (db mode only). */
export async function githubAppConfig(): Promise<ResolvedGitHubApp | undefined> {
  const env = appConfigFromEnv(process.env);
  if (env) {
    return { config: env, source: "env", slug: process.env.GITHUB_APP_SLUG ?? null, htmlUrl: process.env.GITHUB_APP_SLUG ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}` : null, owner: null, webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null };
  }
  if (dataMode() !== "db") return undefined;
  const secret = process.env.RELAY_SESSION_SECRET;
  const db = await getDb();
  const id = await repo.getSetting(db, KEYS.id);
  if (!id) return undefined;
  const key = secret ? await repo.getSetting(db, KEYS.private_key, { secret }) : undefined;
  if (!key) return undefined;
  const slug = (await repo.getSetting(db, KEYS.slug)) ?? null;
  const cfg: GitHubAppConfig = { appId: id, privateKey: key };
  if (slug) cfg.slug = slug;
  if (process.env.GITHUB_API_URL) cfg.apiUrl = process.env.GITHUB_API_URL.replace(/\/$/, "");
  return {
    config: cfg,
    source: "settings",
    slug,
    htmlUrl: (await repo.getSetting(db, KEYS.html_url)) ?? (slug ? `https://github.com/apps/${slug}` : null),
    owner: (await repo.getSetting(db, KEYS.owner)) ?? null,
    webhookSecret: secret ? ((await repo.getSetting(db, KEYS.webhook_secret, { secret })) ?? null) : null,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __relayGitHubApp: { key: string; app: GitHubApp } | undefined;
}

/** One GitHubApp per configuration so installation-token caches survive across requests on a warm instance. */
export async function githubApp(): Promise<GitHubApp | undefined> {
  const resolved = await githubAppConfig();
  if (!resolved) return undefined;
  const key = `${resolved.source}:${resolved.config.appId}:${resolved.config.privateKey.length}`;
  if (!globalThis.__relayGitHubApp || globalThis.__relayGitHubApp.key !== key) globalThis.__relayGitHubApp = { key, app: new GitHubApp(resolved.config) };
  return globalThis.__relayGitHubApp.app;
}

/** Secrets the GitHub webhook may be signed with: the environment's, and the app's own when the manifest flow created it. */
export async function githubWebhookSecrets(): Promise<string[]> {
  const out = new Set<string>();
  if (process.env.GITHUB_WEBHOOK_SECRET) out.add(process.env.GITHUB_WEBHOOK_SECRET);
  if (dataMode() === "db" && process.env.RELAY_SESSION_SECRET) {
    const stored = await repo.getSetting(await getDb(), KEYS.webhook_secret, { secret: process.env.RELAY_SESSION_SECRET }).catch(() => undefined);
    if (stored) out.add(stored);
  }
  return [...out];
}

/** What `POST https://github.com/settings/apps/new` receives: the app relay needs, pointing back at this site. */
export function appManifest(opts: { name?: string } = {}): Record<string, unknown> {
  return {
    name: opts.name ?? `relay-${new URL(SITE_URL).hostname.split(".")[0]}`,
    url: SITE_URL,
    description: "relay: GitHub issues as the task bus for one person's coding-agent subscriptions. Opens tasks, reads runs and PRs, comments on reviews.",
    hook_attributes: { url: `${SITE_URL}/api/webhooks/github`, active: true },
    redirect_url: `${SITE_URL}/setup/github/callback`,
    callback_urls: [`${SITE_URL}/auth/github/callback`],
    setup_url: `${SITE_URL}/setup/github`,
    setup_on_update: false,
    public: false,
    default_permissions: { actions: "read", contents: "read", deployments: "read", issues: "write", metadata: "read", pull_requests: "write" },
    default_events: ["issues", "issue_comment", "pull_request", "pull_request_review", "workflow_run", "deployment_status"],
  };
}

/** The GitHub page the manifest is posted to: the person's account, or an organization's. */
export function manifestTarget(org: string | null | undefined): string {
  const o = org?.trim();
  return o && /^[\w.-]+$/.test(o) ? `https://github.com/organizations/${o}/settings/apps/new` : "https://github.com/settings/apps/new";
}

/**
 * The manifest flow's `state`, verifiable on the callback without a cookie: `<ts>.<hmac(ts|login)>` under
 * RELAY_SESSION_SECRET, good for an hour and bound to the signed-in login.
 */
export function manifestState(login: string, secret: string, now: number = Date.now()): string {
  const ts = String(Math.floor(now / 1000));
  return `${ts}.${createHmac("sha256", secret).update(`${ts}|${login.toLowerCase()}`).digest("base64url")}`;
}

export function verifyManifestState(state: string | null | undefined, login: string, secret: string | undefined, now: number = Date.now()): boolean {
  if (!state || !secret) return false;
  const [ts, mac] = state.split(".");
  if (!ts || !mac) return false;
  const age = Math.floor(now / 1000) - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > 3600) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${ts}|${login.toLowerCase()}`).digest("base64url"));
  const got = Buffer.from(mac);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface ManifestConversion {
  id: number;
  slug: string;
  html_url: string;
  owner: string | null;
  pem: string;
  webhook_secret: string | null;
  client_id: string | null;
  client_secret: string | null;
}

/** `POST /app-manifests/{code}/conversions`: the one call that turns the manifest code into an app. */
export async function convertManifest(code: string, apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com"): Promise<ManifestConversion> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "relay-web", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub app-manifest conversion failed (${res.status}).`);
  const j = (await res.json()) as Record<string, unknown>;
  if (typeof j.id !== "number" || typeof j.pem !== "string" || typeof j.slug !== "string") throw new Error("GitHub returned an incomplete app.");
  return {
    id: j.id,
    slug: j.slug,
    html_url: typeof j.html_url === "string" ? j.html_url : `https://github.com/apps/${j.slug}`,
    owner: typeof (j.owner as Record<string, unknown> | undefined)?.login === "string" ? String((j.owner as Record<string, unknown>).login) : null,
    pem: j.pem,
    webhook_secret: typeof j.webhook_secret === "string" ? j.webhook_secret : null,
    client_id: typeof j.client_id === "string" ? j.client_id : null,
    client_secret: typeof j.client_secret === "string" ? j.client_secret : null,
  };
}

/** Store what the conversion returned: ids plain, secrets sealed. Needs RELAY_SESSION_SECRET. */
export async function storeGitHubApp(app: ManifestConversion): Promise<void> {
  const secret = process.env.RELAY_SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("RELAY_SESSION_SECRET must be set to store the GitHub App's key.");
  const db = await getDb();
  await repo.putSetting(db, KEYS.id, String(app.id));
  await repo.putSetting(db, KEYS.slug, app.slug);
  await repo.putSetting(db, KEYS.html_url, app.html_url);
  if (app.owner) await repo.putSetting(db, KEYS.owner, app.owner);
  await repo.putSetting(db, KEYS.private_key, app.pem, { secret });
  if (app.webhook_secret) await repo.putSetting(db, KEYS.webhook_secret, app.webhook_secret, { secret });
  if (app.client_id) await repo.putSetting(db, KEYS.client_id, app.client_id);
  if (app.client_secret) await repo.putSetting(db, KEYS.client_secret, app.client_secret, { secret });
  globalThis.__relayGitHubApp = undefined;
}

export async function forgetGitHubApp(): Promise<number> {
  globalThis.__relayGitHubApp = undefined;
  return repo.deleteSettings(await getDb(), SETTINGS_PREFIX);
}
