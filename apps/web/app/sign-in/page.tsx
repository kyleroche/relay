import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { safeNextPath } from "@/lib/access";
import { oauthConfig } from "@/lib/github-oauth";
import { getSession } from "@/lib/session";
import { REPO_URL } from "@/lib/site";
import { parseAllowedUsers } from "@/lib/session-token";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to relay with GitHub.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const ERRORS: Record<string, string> = {
  denied: "That GitHub account is not on this site's allowlist. Ask the operator to add your login to RELAY_ALLOWED_USERS.",
  "no-allowlist": "RELAY_ALLOWED_USERS is empty, so nobody can sign in yet. Set it to the GitHub logins that may use this site and redeploy.",
  unconfigured: "Sign-in is not configured: GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET and RELAY_SESSION_SECRET must all be set.",
  state: "That sign-in attempt expired or did not start here. Try again.",
  exchange: "GitHub did not accept the sign-in code. Try again.",
  user: "GitHub did not return an account for that sign-in. Try again.",
  github: "GitHub cancelled the sign-in. Try again.",
};

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const next = safeNextPath(one(sp.next));
  const session = await getSession();
  if (session) redirect(next);

  const errorCode = one(sp.error);
  const error = errorCode ? ERRORS[errorCode] ?? "Sign-in failed. Try again." : null;
  const { missing } = oauthConfig();
  const allowlistEmpty = parseAllowedUsers(process.env.RELAY_ALLOWED_USERS).length === 0;
  const setup = missing.length > 0 ? `Not configured yet: set ${missing.join(", ")}.` : allowlistEmpty ? "RELAY_ALLOWED_USERS is empty: add the GitHub logins that may sign in." : null;

  return (
    <section className="mx-auto flex max-w-sm flex-col gap-6 py-20 sm:py-28">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">The feed, projects, usage, workers and assets are for the people who run this relay.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-bad/40 bg-bad/5 p-3 text-sm">
          {error}
        </p>
      )}

      <Button asChild size="lg" className="w-full">
        <a href={`/auth/github/start?next=${encodeURIComponent(next)}`}>
          <GitHubMark className="size-4" />
          Continue with GitHub
        </a>
      </Button>

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>
          Only the GitHub logins listed in <code className="rounded bg-muted px-1 font-mono">RELAY_ALLOWED_USERS</code> can sign in; relay asks GitHub for{" "}
          <code className="rounded bg-muted px-1 font-mono">read:user</code> and keeps nothing but a signed session cookie.
        </p>
        {setup && (
          <p className="rounded-md border border-warn/40 bg-warn/5 p-2 text-foreground">
            <span className="font-medium">Setup: </span>
            {setup} See{" "}
            <a href={`${REPO_URL}/blob/main/docs/HOSTING.md`} className="underline underline-offset-4" rel="noopener">
              the hosting guide
            </a>
            .
          </p>
        )}
        <p>
          Agents, runners and the CLI do not sign in here. They call <code className="rounded bg-muted px-1 font-mono">/api/v1</code> and <code className="rounded bg-muted px-1 font-mono">/mcp</code> with a bearer token from{" "}
          <code className="rounded bg-muted px-1 font-mono">relay token create</code>. <Link href="/docs/api" className="underline underline-offset-4">API docs</Link>.
        </p>
      </div>
    </section>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
