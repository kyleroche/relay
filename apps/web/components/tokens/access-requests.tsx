"use client";

import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideAccessAction, type TokenActionResult } from "@/app/tokens/actions";
import { Scopes } from "@/components/tokens/bits";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export type RequestState = "pending" | "approved" | "redeemed" | "denied" | "expired";

/** One device request as the page renders it. Times are relative strings made on the server ("2 h ago", "in 12 min"). */
export interface RequestView {
  user_code: string;
  client_name: string;
  scopes: string[];
  state: RequestState;
  requested: string;
  expires: string;
  decided: string | null;
  /** "kyle" for human:kyle, "bot:woodhouse" for a bot */
  decided_by: string | null;
  token_name: string | null;
}

const isLive = (r: RequestView) => r.state === "pending" || r.state === "approved";

/**
 * Requests: what is waiting (pending codes with Approve and Deny, approvals the client has not polled for yet) and,
 * folded away, the decisions of the last day. Approve and Deny call the same core function as /activate.
 */
export function AccessRequests({ requests, canWrite }: { requests: RequestView[]; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [pending, start] = useTransition();
  const live = requests.filter(isLive);
  const past = requests.filter((r) => !isLive(r));

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

  const meta = (r: RequestView): string => {
    switch (r.state) {
      case "pending":
        return `asked ${r.requested}, expires ${r.expires}`;
      case "approved":
        return `approved by ${r.decided_by} ${r.decided}, waiting for it to poll`;
      case "redeemed":
        return `approved by ${r.decided_by} ${r.decided}, token ${r.token_name ?? "since revoked"}`;
      case "denied":
        return `denied by ${r.decided_by} ${r.decided}`;
      case "expired":
        return `asked ${r.requested}, nobody decided in time`;
    }
  };

  const Row = ({ r }: { r: RequestView }) => (
    <li className={cn("flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between", !isLive(r) && "opacity-60")}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{r.client_name}</span>
          {r.state === "pending" && (
            <Pill tone="warn" mono>
              {r.user_code}
            </Pill>
          )}
          {r.state === "approved" && <Pill tone="primary">approved</Pill>}
          {r.state === "denied" && <Pill>denied</Pill>}
          {r.state === "expired" && <Pill>expired</Pill>}
          <Scopes scopes={r.scopes} />
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta(r)}</p>
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
  );

  return (
    <div>
      {result && !result.ok && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {result.message}
        </p>
      )}
      {live.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting. A bot or CLI that asks for access shows up here with its code.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {live.map((r) => (
            <Row key={r.user_code} r={r} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowPast((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-expanded={showPast}>
            {showPast ? "Hide" : "Show"} {past.length} decided in the last day
          </button>
          {showPast && (
            <ul className="mt-2 divide-y rounded-lg border">
              {past.map((r) => (
                <Row key={r.user_code} r={r} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
