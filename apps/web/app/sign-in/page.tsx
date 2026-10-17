import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert } from "@/components/alert";
import { GitHubMark } from "@/components/shell/github-mark";
import { Button } from "@/components/ui/button";
import { safeNextPath } from "@/lib/access";
import { oauthConfig } from "@/lib/github-oauth";
import { getSession } from "@/lib/session";
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
        <p className="mt-2 text-sm text-muted-foreground">Sign in to see this relay&apos;s feed and decide on its tasks.</p>
      </div>

      {waiting && <Alert tone="primary">{waiting === "device" ? "A CLI or bot is waiting for you to approve its access code. Sign in and you will see what it asks for." : "An application is asking for access to relay. Sign in to see what it asks for and decide."}</Alert>}

      {error && <Alert tone="bad">{error}</Alert>}

      <Button asChild className="w-full">
        <a href={`/auth/github/start?next=${encodeURIComponent(next)}`}>
          <GitHubMark className="size-4" />
          Continue with GitHub
        </a>
      </Button>

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        {setup && (
          <Alert tone="warn" className="text-xs text-foreground">
            <span className="font-medium">Setup: </span>
            {setup} See{" "}
            <Link href="/docs/hosting" className="underline underline-offset-4">
              Hosting
            </Link>
            .
          </Alert>
        )}
        <p>
          Agents and the CLI do not sign in here; they ask for access and a signed-in person approves once.{" "}
          <Link href="/docs/api#access" className="underline underline-offset-4">
            How access works
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
