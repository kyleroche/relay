"use client";

import { Check, Hourglass, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideAccessAction, type TokenActionResult } from "@/app/tokens/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type RequestState = "pending" | "approved" | "redeemed" | "denied" | "expired";

/** One device request as the page renders it; times are preformatted on the server so the markup matches on hydration. */
export interface RequestView {
  user_code: string;
  client_name: string;
  scopes: string[];
  state: RequestState;
  /** "2026-10-16 18:04 UTC" */
  requested: string;
  expires: string;
  decided: string | null;
  /** "kyle" for human:kyle, "bot:woodhouse" for a bot */
  decided_by: string | null;
  token_name: string | null;
}

const STATE_LABEL: Record<RequestState, string> = {
  pending: "waiting for you",
  approved: "approved, waiting for the client to poll",
  redeemed: "redeemed",
  denied: "denied",
  expired: "expired",
};

/**
 * Requests: pending codes with Approve and Deny inline, approvals that the client has not picked up yet, and the
 * decisions of the last day. Approve and Deny call the same core function as /activate, so the feed row is the same.
 */
export function AccessRequests({ requests, canWrite }: { requests: RequestView[]; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const decide = (code: string, decision: "approve" | "deny") => {
    if (pending) return;
    setBusy(code);
    start(async () => {
      const r = await decideAccessAction(code, decision);
      setResult(r.ok ? null : r);
      setBusy(null);
      router.refresh();
    });
  };

  if (requests.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nothing is asking right now. A bot or CLI asks at <code className="font-mono">/oauth/device</code> and shows a code like <code className="font-mono">RLAY-4F7Q</code>; it appears here (and on{" "}
        <Link href="/activate" className="underline underline-offset-2 hover:text-foreground">
          /activate
        </Link>
        ) the moment it does. See{" "}
        <Link href="/docs/api#access" className="underline underline-offset-2 hover:text-foreground">
          how agents get access
        </Link>
        .
      </p>
    );
  }

  return (
    <div>
      {result && !result.ok && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {result.message}
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {requests.map((r) => (
          <li key={r.user_code} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between", (r.state === "denied" || r.state === "expired") && "opacity-70")}>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-medium">{r.client_name}</span>
                <span className="font-mono text-xs text-muted-foreground">{r.user_code}</span>
                <StateBadge state={r.state} />
              </p>
              <p className="mt-0.5 flex flex-wrap gap-1">
                {r.scopes.map((s) => (
                  <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {s}
                  </code>
                ))}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {r.state === "pending" && <>requested {r.requested} · expires {r.expires}</>}
                {r.state === "approved" && (
                  <>
                    approved by {r.decided_by} {r.decided}; waiting for <span className="font-mono">{r.client_name}</span> to poll <code className="font-mono">/oauth/token</code> · expires {r.expires}
                  </>
                )}
                {r.state === "redeemed" && (
                  <>
                    approved by {r.decided_by} {r.decided} → token <span className="font-mono">{r.token_name ?? "(revoked)"}</span>
                  </>
                )}
                {r.state === "denied" && (
                  <>
                    denied by {r.decided_by} {r.decided}
                  </>
                )}
                {r.state === "expired" && <>requested {r.requested}; nobody decided before {r.expires}</>}
              </p>
            </div>
            {r.state === "pending" && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => decide(r.user_code, "approve")} disabled={!canWrite || pending} aria-label={`Approve ${r.user_code} for ${r.client_name}`}>
                  <Check className="size-3.5" /> {busy === r.user_code ? "Working" : "Approve"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => decide(r.user_code, "deny")} disabled={!canWrite || pending} aria-label={`Deny ${r.user_code} for ${r.client_name}`}>
                  <X className="size-3.5" /> Deny
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StateBadge({ state }: { state: RequestState }) {
  const tone = state === "pending" ? "border-warn/50 text-warn" : state === "approved" ? "border-primary/50 text-primary" : state === "redeemed" ? "border-ok/50 text-ok" : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide", tone)}>
      {state === "approved" && <Hourglass className="size-3" aria-hidden="true" />}
      {STATE_LABEL[state]}
    </span>
  );
}
