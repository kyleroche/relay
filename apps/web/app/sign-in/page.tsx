import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { GitHubMark } from "@/components/shell/github-mark";
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

  const waiting = next.startsWith("/activate") ? "device" : next.startsWith("/oauth/authorize") ? "client" : null;

  return (
    <section className="mx-auto flex max-w-sm flex-col gap-6 py-20 sm:py-28">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">The feed, projects, usage, workers and assets are for the people who run this relay.</p>
      </div>

      {waiting && (
        <p role="status" className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          {waiting === "device" ? "A CLI or bot is waiting for you to approve its access code. Sign in and you will see what it asks for." : "An application is asking for access to relay. Sign in to see what it asks for and decide."}
        </p>
      )}

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
          Agents, workers and the CLI do not sign in here. They request access themselves (<code className="rounded bg-muted px-1 font-mono">POST /oauth/device</code>, or <code className="rounded bg-muted px-1 font-mono">relay setup --site</code>) and a signed-in person approves the code once. <Link href="/docs/api#access" className="underline underline-offset-4">How access works</Link>.
        </p>
      </div>
    </section>
  );
}
