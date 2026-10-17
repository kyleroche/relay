import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { OAuthError, scopeDescriptions, validateAuthorizeRequest, type AuthorizeRequest } from "@relay/core";
import { DemoNotice } from "@/components/demo-notice";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { oauthOptions } from "@/lib/oauth";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Authorize",
  description: "Approve or deny an application's request for a relay token.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/**
 * GET /oauth/authorize: the consent page. Needs the relay session (anonymous visitors go to /sign-in and come back
 * with the same query). Shows who is asking, what each scope lets them do, and two buttons. The decision posts to
 * /oauth/authorize/decision, which re-validates everything and redirects to the client with a code or access_denied.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const s = one(v);
    if (s) qs.set(k, s);
  }
  const session = await requireSession(`/oauth/authorize?${qs.toString()}`);
  if (dataMode() !== "db") {
    return (
      <section className="mx-auto flex max-w-md flex-col gap-4 py-16 sm:py-24">
        <h1 className="text-2xl font-semibold tracking-tight">Authorize</h1>
        <DemoNotice />
      </section>
    );
  }

  let request: AuthorizeRequest;
  try {
    const v = await validateAuthorizeRequest(
      await getDb(),
      { response_type: one(sp.response_type), client_id: one(sp.client_id), redirect_uri: one(sp.redirect_uri), scope: one(sp.scope), state: one(sp.state), code_challenge: one(sp.code_challenge), code_challenge_method: one(sp.code_challenge_method), resource: one(sp.resource) },
      oauthOptions(),
    );
    if ("redirectError" in v) redirect(v.redirectError);
    request = v.request;
  } catch (e) {
    if (e instanceof OAuthError) return <Notice title="This request cannot be approved" body={`${e.description} (${e.code}). Nothing was sent to the application; close this page and start again from it.`} />;
    throw e;
  }

  const redirectHost = new URL(request.redirect_uri).host;
  return (
    <section className="mx-auto flex max-w-md flex-col gap-6 py-16 sm:py-24">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{request.client.name} wants access to relay</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{session.login}</span>. Approving mints a token named <code className="rounded bg-muted px-1 font-mono">oauth:{request.client.name}</code> that lasts 24 hours and renews itself for 90 days; every write it makes is attributed to it in the feed. Revoke it any time on{" "}
          <Link href="/tokens" className="underline underline-offset-4">
            Access
          </Link>
          .
        </p>
      </div>

      <div className="rounded-lg border p-4">
        <SectionHeading>It asks to</SectionHeading>
        <ul className="mt-2 flex flex-col gap-1.5 text-sm">
          {scopeDescriptions(request.scopes).map((s) => (
            <li key={s.scope} className="flex items-start gap-2">
              <code className="shrink-0 rounded bg-muted px-1 font-mono text-xs leading-5">{s.scope}</code>
              <span className="text-muted-foreground">{s.description}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          After you decide, the browser returns to <span className="font-mono">{redirectHost}</span>
          {request.resource ? <> for <span className="font-mono">{request.resource}</span></> : null}.
        </p>
      </div>

      <form method="post" action="/oauth/authorize/decision" className="flex flex-col gap-3 sm:flex-row">
        <input type="hidden" name="client_id" value={request.client.client_id} />
        <input type="hidden" name="redirect_uri" value={request.redirect_uri} />
        <input type="hidden" name="scope" value={request.scopes.join(" ")} />
        {request.state ? <input type="hidden" name="state" value={request.state} /> : null}
        <input type="hidden" name="code_challenge" value={request.code_challenge} />
        <input type="hidden" name="code_challenge_method" value={request.code_challenge_method} />
        {request.resource ? <input type="hidden" name="resource" value={request.resource} /> : null}
        <Button type="submit" name="decision" value="approve" size="lg" className="flex-1">
          Approve
        </Button>
        <Button type="submit" name="decision" value="deny" size="lg" variant="outline" className="flex-1">
          Deny
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        Not expecting this? Deny. Only approve requests you started yourself, from a client you recognise. <Link href="/docs/security" className="underline underline-offset-4">How access works</Link>.
      </p>
    </section>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <section className="mx-auto flex max-w-md flex-col gap-4 py-16 sm:py-24">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </section>
  );
}
