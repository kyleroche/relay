import type { Metadata } from "next";
import Link from "next/link";
import { listApprovedAwaitingPoll, listPendingAccess, lookupDeviceRequest, normalizeUserCode, scopeDescriptions, type AccessRequestView, type DeviceCodeRow } from "@relay/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { oauthOptions } from "@/lib/oauth";
import { requireSession } from "@/lib/session";
import { activateAction } from "./actions";

export const metadata: Metadata = {
  title: "Activate a device",
  description: "Approve a CLI or bot that asked for access with a code.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * GET /activate[?code=RLAY-4F7Q]: the device flow's verification page. Without a code: a field to type one and the
 * list of requests still waiting. With one: who asked, which scopes, approve or deny. Decisions go through the
 * server action, which writes access.granted / access.denied to the feed.
 */
export default async function ActivatePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const typed = one(sp.code) ?? "";
  await requireSession(`/activate${typed ? `?code=${encodeURIComponent(typed)}` : ""}`);
  const db = dataMode() === "db";
  const done = one(sp.done);
  const error = one(sp.error);
  const request = db && typed ? await lookupDeviceRequest(await getDb(), typed, oauthOptions()) : undefined;
  const pending: DeviceCodeRow[] = db ? await listPendingAccess(await getDb(), oauthOptions()) : [];
  const awaiting: AccessRequestView[] = db ? await listApprovedAwaitingPoll(await getDb(), oauthOptions()) : [];
  const normalized = normalizeUserCode(typed);
  const utc = (iso: string): string => `${iso.slice(11, 16)} UTC`;

  return (
    <section className="mx-auto flex max-w-md flex-col gap-6 py-16 sm:py-24">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Activate</p>
          <Link href="/tokens" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Back to Access
          </Link>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Approve a device</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A CLI or bot that ran <code className="rounded bg-muted px-1 font-mono">relay setup --site</code> shows a code like <code className="rounded bg-muted px-1 font-mono">RLAY-4F7Q</code>. Enter it here, check what it asks for, and approve. The token it receives lasts 24 hours and renews for 90 days; revoke it on{" "}
          <Link href="/tokens" className="underline underline-offset-4">
            Access
          </Link>
          .
        </p>
      </div>

      {!db && <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; device approvals need a database.</p>}

      {done && (
        <p role="status" className={`rounded-md border p-3 text-sm ${done === "approved" ? "border-primary/40 bg-primary/5" : "border-warn/40 bg-warn/5"}`}>
          {done === "approved" ? <>Approved. <span className="font-mono">{one(sp.client)}</span> will receive its token on its next poll; you can close this page.</> : <>Denied. <span className="font-mono">{one(sp.client)}</span> will be told so.</>}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-bad/40 bg-bad/5 p-3 text-sm">
          {error}
        </p>
      )}

      {request && !done ? (
        <div className="rounded-lg border p-4">
          <h2 className="text-sm font-medium">
            <span className="font-mono">{request.client_name}</span> asks for access
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Code <span className="font-mono">{request.user_code}</span>, requested {new Date(request.created_at).toLocaleString("en-GB", { timeZone: "UTC", hour12: false })} UTC
            {request.expired ? ", expired" : request.status !== "pending" ? `, already ${request.status}` : ""}.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {scopeDescriptions(request.scopes).map((s) => (
              <li key={s.scope} className="flex items-start gap-2">
                <code className="shrink-0 rounded bg-muted px-1 font-mono text-xs leading-5">{s.scope}</code>
                <span className="text-muted-foreground">{s.description}</span>
              </li>
            ))}
          </ul>
          {request.status === "pending" && !request.expired ? (
            <form action={activateAction} className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input type="hidden" name="code" value={request.user_code} />
              <Button type="submit" name="decision" value="approve" className="flex-1">
                Approve
              </Button>
              <Button type="submit" name="decision" value="deny" variant="outline" className="flex-1">
                Deny
              </Button>
            </form>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Nothing to decide: ask the device to run the command again for a fresh code.</p>
          )}
        </div>
      ) : (
        <form method="get" action="/activate" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Code</span>
            <Input name="code" defaultValue={typed} placeholder="RLAY-4F7Q" autoComplete="off" autoCapitalize="characters" spellCheck={false} className="font-mono uppercase" aria-label="Device code" />
          </label>
          <Button type="submit" disabled={!db}>
            Look up
          </Button>
        </form>
      )}
      {typed && !request && db && !done && (
        <p role="alert" className="text-sm text-muted-foreground">
          No request matches <span className="font-mono">{normalized ?? typed}</span>. Codes expire after 15 minutes; ask the device to try again.
        </p>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="pending-h">
          <h2 id="pending-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Waiting for a decision <span className="font-mono tabular-nums">{pending.length}</span>
          </h2>
          <ul className="divide-y rounded-lg border text-sm">
            {pending.map((p) => (
              <li key={p.user_code} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">
                  <span className="font-mono">{p.user_code}</span> <span className="text-muted-foreground">from</span> <span className="font-mono">{p.client_name}</span>
                </span>
                <Link href={`/activate?code=${encodeURIComponent(p.user_code)}`} className="shrink-0 underline underline-offset-4">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {awaiting.length > 0 && (
        <section aria-labelledby="awaiting-h">
          <h2 id="awaiting-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Approved, waiting for the device to poll <span className="font-mono tabular-nums">{awaiting.length}</span>
          </h2>
          <ul className="divide-y rounded-lg border text-sm">
            {awaiting.map((a) => (
              <li key={a.user_code} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="min-w-0 break-all">
                  <span className="font-mono">{a.user_code}</span> <span className="text-muted-foreground">for</span> <span className="font-mono">{a.client_name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">token on its next poll; code expires {utc(a.expires_at)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            The token is minted when the device next calls <code className="font-mono">/oauth/token</code>; it will then appear under Grants on{" "}
            <Link href="/tokens" className="underline underline-offset-4">
              Access
            </Link>
            .
          </p>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Approvals can also come from a bot: <code className="rounded bg-muted px-1 font-mono">POST /api/v1/access/&lt;code&gt;/approve</code> with a <code className="font-mono">tokens:write</code> token, so a reply over chat can approve. Every request and decision is an <code className="font-mono">access.*</code> row in the feed.
      </p>
    </section>
  );
}
