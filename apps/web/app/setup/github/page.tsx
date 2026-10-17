import type { Metadata } from "next";
import Link from "next/link";
import type { InstallationInfo } from "@relay/core";
import { Alert } from "@/components/alert";
import { ManifestForm } from "@/components/github/manifest-form";
import { PageIntro } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { dataMode, SITE_URL } from "@/lib/data";
import { appManifest, githubApp, githubAppConfig, manifestState, type ResolvedGitHubApp } from "@/lib/github-app";
import { requireSession } from "@/lib/session";
import { forgetGitHubAppAction } from "./actions";

export const metadata: Metadata = {
  title: "GitHub App",
  description: "Connect relay to GitHub as one app: install status, or create the app in one click.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * GET /setup/github: how this site talks to GitHub, as one status card and one action row. Configured (environment or
 * stored): the app and where it is installed, with the install link. Not configured: what the app would be, and the
 * one-click manifest flow that creates it on GitHub and posts the credentials back to /setup/github/callback.
 */
export default async function GitHubSetupPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const session = await requireSession("/setup/github");
  const db = dataMode() === "db";
  const resolved = await githubAppConfig().catch(() => undefined);
  const org = one(sp.org) ?? "";
  const error = one(sp.error);
  const created = one(sp.created);
  const forgot = one(sp.forgot);
  const secret = process.env.RELAY_SESSION_SECRET;
  const canManifest = db && !!secret && secret.length >= 16;
  let installations: InstallationInfo[] = [];
  let installError: string | null = null;
  if (resolved) {
    try {
      installations = (await (await githubApp())?.listInstallations()) ?? [];
    } catch (e) {
      installError = e instanceof Error ? e.message : String(e);
    }
  }
  const legacyToken = !!(process.env.GITHUB_APP_TOKEN || process.env.GITHUB_TOKEN);

  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">GitHub App</h1>
        <PageIntro doc="/docs/hosting">relay talks to GitHub as one app, installed once per organization instead of a personal token.</PageIntro>
      </section>

      {error ? (
        <Alert tone="bad" className="mb-6">
          {error}
        </Alert>
      ) : created ? (
        <Alert tone="primary" className="mb-6">
          GitHub created <span className="font-mono">{created}</span> and relay stored its key and webhook secret (sealed). Install it on the repositories relay should manage.
        </Alert>
      ) : forgot ? (
        <Alert className="mb-6">Removed the stored app ({forgot} settings). Delete the app on GitHub too if you no longer use it.</Alert>
      ) : null}

      {resolved ? <Configured resolved={resolved} installations={installations} installError={installError} /> : <Manifest canManifest={canManifest} db={db} org={org} login={session.login} secret={secret} legacyToken={legacyToken} />}
    </>
  );
}

function Configured({ resolved, installations, installError }: { resolved: ResolvedGitHubApp; installations: InstallationInfo[]; installError: string | null }) {
  const installUrl = resolved.slug ? `https://github.com/apps/${resolved.slug}/installations/new` : "https://github.com/settings/installations";
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="status-h" className="rounded-lg border bg-card p-4 sm:p-5">
        <h2 id="status-h" className="text-sm font-medium">
          Configured
        </h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">App</dt>
          <dd>
            {resolved.htmlUrl ? (
              <a href={resolved.htmlUrl} className="font-mono underline underline-offset-4" rel="noopener noreferrer">
                {resolved.slug ?? resolved.htmlUrl}
              </a>
            ) : (
              <span className="text-muted-foreground">slug unknown (set GITHUB_APP_SLUG for an install link)</span>
            )}
            {resolved.owner ? <span className="text-muted-foreground"> owned by {resolved.owner}</span> : null}
            <span className="ml-2 font-mono text-xs text-muted-foreground">id {resolved.config.appId}</span>
          </dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{resolved.source === "env" ? <>environment (<code className="font-mono">GITHUB_APP_ID</code>, <code className="font-mono">GITHUB_APP_PRIVATE_KEY</code>)</> : <>stored by the manifest flow, sealed under <code className="font-mono">RELAY_SESSION_SECRET</code></>}</dd>
          <dt className="text-muted-foreground">Webhook secret</dt>
          <dd>{resolved.webhookSecret ? "present; deliveries to /api/webhooks/github are verified" : <span className="text-warn">missing: set GITHUB_WEBHOOK_SECRET to the app's webhook secret</span>}</dd>
        </dl>
        <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Link href="/docs/hosting" className="underline underline-offset-2 hover:text-foreground">
            How to rotate the key
          </Link>
          {resolved.source === "settings" && (
            <form action={forgetGitHubAppAction}>
              <Button type="submit" variant="outline" size="xs">
                Remove the stored app
              </Button>
            </form>
          )}
        </p>
      </section>

      <section aria-labelledby="installs-h">
        <div className="flex items-center justify-between gap-3">
          <h2 id="installs-h" className="text-xs font-medium text-muted-foreground">
            Installations <span className="font-mono tabular-nums">{installations.length}</span>
          </h2>
          <Button asChild size="sm">
            <a href={installUrl} rel="noopener noreferrer">
              Install on an account
            </a>
          </Button>
        </div>
        {installError ? (
          <Alert tone="bad" className="mt-2">
            Could not list installations: {installError}
          </Alert>
        ) : installations.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Not installed anywhere yet. Install it on the organization whose repositories relay manages, and pick the repositories.</p>
        ) : (
          <ul className="mt-2 divide-y rounded-lg border text-sm">
            {installations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <span className="font-medium">{i.account}</span> <span className="text-muted-foreground">({i.account_type.toLowerCase()}, {i.repository_selection === "all" ? "all repositories" : "selected repositories"})</span>
                  {i.suspended_at ? <span className="ml-2 text-warn">suspended</span> : null}
                </span>
                <a href={i.html_url} className="text-xs underline underline-offset-4" rel="noopener noreferrer">
                  manage
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Manifest({ canManifest, db, org, login, secret, legacyToken }: { canManifest: boolean; db: boolean; org: string; login: string; secret: string | undefined; legacyToken: boolean }) {
  const manifest = appManifest();
  const state = canManifest ? manifestState(login, secret!) : "";
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="status-h" className="rounded-lg border bg-card p-4 sm:p-5">
        <h2 id="status-h" className="text-sm font-medium">
          Not configured
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {legacyToken ? (
            <>
              Issues open with a personal token (<code className="font-mono">GITHUB_TOKEN</code>); an app has narrower permissions and does not depend on one account.
            </>
          ) : (
            <>
              Without GitHub access relay cannot open tasks (<code className="font-mono">relay_task_create</code> answers 503).
            </>
          )}
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">App</dt>
          <dd className="font-mono">{String(manifest.name)}</dd>
          <dt className="text-muted-foreground">Permissions</dt>
          <dd className="font-mono">
            {Object.entries(manifest.default_permissions as Record<string, string>)
              .map(([k, v]) => `${k}:${v}`)
              .join("  ")}
          </dd>
          <dt className="text-muted-foreground">Events</dt>
          <dd className="font-mono">{(manifest.default_events as string[]).join("  ")}</dd>
          <dt className="text-muted-foreground">Webhook</dt>
          <dd className="font-mono">{SITE_URL}/api/webhooks/github</dd>
        </dl>
        {!db && <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; the manifest flow stores the app in the database and needs RELAY_DATA=db or DATABASE_URL.</p>}
        {db && !canManifest && (
          <Alert tone="warn" className="mt-3 text-xs">
            Set <code className="font-mono">RELAY_SESSION_SECRET</code> (32+ characters, <code className="font-mono">openssl rand -hex 32</code>) first: the app&apos;s private key is sealed with it.
          </Alert>
        )}
      </section>

      <section aria-labelledby="create-h">
        <h2 id="create-h" className="mb-2 text-xs font-medium text-muted-foreground">
          Create the app on GitHub
        </h2>
        <ManifestForm manifest={JSON.stringify(manifest)} state={state} disabled={!canManifest} initialOrg={org} />
        <p className="mt-2 text-xs text-muted-foreground">
          GitHub shows the app above, asks you to confirm and sends the credentials back here. Or create it yourself and set <code className="font-mono">GITHUB_APP_ID</code>, <code className="font-mono">GITHUB_APP_PRIVATE_KEY</code>, <code className="font-mono">GITHUB_APP_SLUG</code> and <code className="font-mono">GITHUB_WEBHOOK_SECRET</code> (
          <Link href="/docs/hosting" className="underline underline-offset-2 hover:text-foreground">
            Hosting
          </Link>
          ).
        </p>
      </section>
    </div>
  );
}
