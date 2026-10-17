"use client";

import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideAccessAction, type TokenActionResult } from "@/app/access/actions";
import { ActorChip } from "@/components/feed/actor-chip";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { ScopeList } from "@/components/ui/scope-list";
import { cn } from "@/lib/utils";

export type RequestState = "pending" | "approved" | "redeemed" | "denied" | "expired";

/** One device request as the page renders it. Times are ISO; the page passes `now` so both renders agree. */
export interface RequestView {
  user_code: string;
  client_name: string;
  scopes: string[];
  state: RequestState;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  /** The deciding actor, "human:kyle" or "bot:woodhouse"; rendered with ActorChip. */
  decided_by: string | null;
  token_name: string | null;
}

const isLive = (r: RequestView) => r.state === "pending" || r.state === "approved";

/**
 * Requests: what is waiting (pending codes with Approve and Deny, approvals the client has not polled for yet) and,
 * folded away, the decisions of the last day. Approve and Deny call the same core function as /activate.
 */
export function AccessRequests({ requests, canWrite, now }: { requests: RequestView[]; canWrite: boolean; now: number }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  const By = ({ r }: { r: RequestView }) => (r.decided_by ? <ActorChip actor={r.decided_by} className="align-middle" /> : null);
  const meta = (r: RequestView) => {
    switch (r.state) {
      case "pending":
        return (
          <>
            asked <RelTime iso={r.created_at} now={now} />, expires <RelTime iso={r.expires_at} now={now} />
          </>
        );
      case "approved":
        return (
          <>
            approved by <By r={r} /> {r.decided_at && <RelTime iso={r.decided_at} now={now} />}, waiting for it to poll
          </>
        );
      case "redeemed":
        return (
          <>
            approved by <By r={r} /> {r.decided_at && <RelTime iso={r.decided_at} now={now} />}, token {r.token_name ?? "since revoked"}
          </>
        );
      case "denied":
        return (
          <>
            denied by <By r={r} /> {r.decided_at && <RelTime iso={r.decided_at} now={now} />}
          </>
        );
      case "expired":
        return (
          <>
            asked <RelTime iso={r.created_at} now={now} />, nobody decided in time
          </>
        );
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
          <ScopeList scopes={r.scopes} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">{meta(r)}</p>
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
        <EmptyState title="Nothing is waiting" as="p">
          A bot or CLI that asks for access shows up here with its code.
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {live.map((r) => (
            <Row key={r.user_code} r={r} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <Disclosure label={`${past.length} decided in the last day`} className="mt-2">
          <ul className="divide-y rounded-lg border">
            {past.map((r) => (
              <Row key={r.user_code} r={r} />
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
