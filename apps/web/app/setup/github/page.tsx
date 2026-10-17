import type { Metadata } from "next";
import Link from "next/link";
import type { InstallationInfo } from "@relay/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dataMode, REPO_URL, SITE_URL } from "@/lib/data";
import { appManifest, githubApp, githubAppConfig, manifestState, manifestTarget, type ResolvedGitHubApp } from "@/lib/github-app";
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
 * GET /setup/github: how this site talks to GitHub. Configured (environment or stored): the app, where it is
 * installed, the install link, and how to rotate. Not configured: a one-click manifest flow that creates the app on
 * GitHub with relay's permissions and events and sends the credentials back to /setup/github/callback.
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
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Setup</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">GitHub App</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          relay opens tasks, reads runs and pull requests and comments on reviews as one GitHub App installed once per organization, instead of a personal token. Tokens are minted per installation, last an hour and live only in memory. Details in{" "}
          <Link href="/docs/hosting" className="underline underline-offset-2 hover:text-foreground">
            Hosting
          </Link>
          .
        </p>
      </section>

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-bad/40 bg-bad/5 p-3 text-sm">
          {error}
        </p>
      )}
      {created && (
        <p role="status" className="mb-6 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          GitHub created <span className="font-mono">{created}</span> and relay stored its key and webhook secret (sealed). Install it on the repositories relay should manage below.
        </p>
      )}
      {forgot && (
        <p role="status" className="mb-6 rounded-md border p-3 text-sm">
          Removed the stored app ({forgot} settings). Delete the app on GitHub too if you no longer use it.
        </p>
      )}

      {resolved ? <Configured resolved={resolved} installations={installations} installError={installError} /> : <Manifest canManifest={canManifest} db={db} org={org} login={session.login} secret={secret} legacyToken={legacyToken} />}
    </>
  );
}

function Configured({ resolved, installations, installError }: { resolved: ResolvedGitHubApp; installations: InstallationInfo[]; installError: string | null }) {
  const installUrl = resolved.slug ? `https://github.com/apps/${resolved.slug}/installations/new` : "https://github.com/settings/installations";
  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-lg border p-4 sm:p-5">
        <h2 className="text-sm font-medium">Configured</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">App id</dt>
          <dd className="font-mono">{resolved.config.appId}</dd>
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
          </dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{resolved.source === "env" ? <>environment (<code className="font-mono">GITHUB_APP_ID</code>, <code className="font-mono">GITHUB_APP_PRIVATE_KEY</code>); the environment always wins over a stored app</> : <>stored by the manifest flow, sealed under <code className="font-mono">RELAY_SESSION_SECRET</code></>}</dd>
          <dt className="text-muted-foreground">Webhook secret</dt>
          <dd>{resolved.webhookSecret ? "present; deliveries to /api/webhooks/github are verified with it" : <span className="text-warn">missing: set GITHUB_WEBHOOK_SECRET to the app's webhook secret</span>}</dd>
        </dl>
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium text-muted-foreground">
            Installations <span className="font-mono tabular-nums">{installations.length}</span>
          </h2>
          <Button asChild size="sm">
            <a href={installUrl} rel="noopener noreferrer">
              Install on an account
            </a>
          </Button>
        </div>
        {installError ? (
          <p role="alert" className="mt-2 rounded-md border border-bad/40 bg-bad/5 p-3 text-sm">
            Could not list installations: {installError}
          </p>
        ) : installations.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Not installed anywhere yet. Install it on the organization (or account) whose repositories relay manages, and pick the repositories.</p>
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
        <p className="mt-2 text-xs text-muted-foreground">
          When the app is installed on a repository that holds a <code className="font-mono">relay.md</code>, relay registers the project by its repository name; otherwise it only logs <code className="font-mono">project.github_connected</code> and waits for <code className="font-mono">relay link</code>.
        </p>
      </section>

      <section className="rounded-lg border p-4 text-xs text-muted-foreground sm:p-5">
        <h2 className="text-sm font-medium text-foreground">Rotate</h2>
        <p className="mt-1">
          Generate a new private key on GitHub, put it in <code className="font-mono">GITHUB_APP_PRIVATE_KEY</code> (the environment wins immediately) or remove the stored app below and run the manifest flow again, then revoke the old key on GitHub. Rotating <code className="font-mono">RELAY_SESSION_SECRET</code> makes a stored key unreadable, which is the same as removing it.
        </p>
        {resolved.source === "settings" && (
          <form action={forgetGitHubAppAction} className="mt-3">
            <Button type="submit" variant="outline" size="sm">
              Remove the stored app
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}

function Manifest({ canManifest, db, org, login, secret, legacyToken }: { canManifest: boolean; db: boolean; org: string; login: string; secret: string | undefined; legacyToken: boolean }) {
  const manifest = appManifest();
  const state = canManifest ? manifestState(login, secret!) : "";
  const target = manifestTarget(org);
  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-lg border p-4 sm:p-5">
        <h2 className="text-sm font-medium">Not configured</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {legacyToken ? (
            <>
              This site opens issues with a personal token (<code className="font-mono">GITHUB_TOKEN</code>). That works, but an app has narrower permissions, mints short-lived tokens per installation and does not depend on one person&apos;s account.
            </>
          ) : (
            <>Without GitHub access, <code className="font-mono">relay_task_create</code> answers 503. Either create the app here in one click or set the variables yourself.</>
          )}
        </p>
        {!db && <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; the manifest flow stores the app in the database and needs RELAY_DATA=db or DATABASE_URL.</p>}
        {db && !canManifest && (
          <p className="mt-3 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
            Set <code className="font-mono">RELAY_SESSION_SECRET</code> (16+ characters) first: the app&apos;s private key is sealed with it.
          </p>
        )}
      </section>

      <section className="rounded-lg border p-4 sm:p-5">
        <h2 className="text-sm font-medium">Create the app in one click</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          GitHub will show the app <span className="font-mono">{String(manifest.name)}</span> with these permissions and events, ask you to confirm, and send the credentials back here. Nothing is typed or copied.
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
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
        <form method="get" action="/setup/github" className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Organization (leave empty for your own account)</span>
            <Input name="org" defaultValue={org} placeholder="acme" autoComplete="off" />
          </label>
          <Button type="submit" variant="outline">
            Set owner
          </Button>
        </form>
        <form method="post" action={`${target}?state=${encodeURIComponent(state)}`} className="mt-3">
          <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
          <Button type="submit" disabled={!canManifest} size="lg">
            Create {org ? `in ${org}` : "on my account"} on GitHub
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          GitHub posts to <span className="font-mono">{target}</span>. After confirming, you land back on this page; then install the app on the repositories relay should manage.
        </p>
      </section>

      <section className="rounded-lg border p-4 text-xs text-muted-foreground sm:p-5">
        <h2 className="text-sm font-medium text-foreground">Or set the variables yourself</h2>
        <p className="mt-1">
          Create the app at GitHub → Settings → Developer settings → GitHub Apps with the permissions and events above, generate a private key, and set <code className="font-mono">GITHUB_APP_ID</code>, <code className="font-mono">GITHUB_APP_PRIVATE_KEY</code> (the PEM, <code className="font-mono">\n</code>-escaped on one line is fine), <code className="font-mono">GITHUB_APP_SLUG</code> and <code className="font-mono">GITHUB_WEBHOOK_SECRET</code>. The environment always wins over a stored app. See{" "}
          <a href={`${REPO_URL}/blob/main/docs/HOSTING.md`} className="underline underline-offset-4" rel="noopener noreferrer">
            docs/HOSTING.md
          </a>
          .
        </p>
      </section>
    </div>
  );
}
