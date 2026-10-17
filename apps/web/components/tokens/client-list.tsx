"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeClientAction, type TokenActionResult } from "@/app/tokens/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ClientView {
  client_id: string;
  name: string;
  /** "device" (asked at /oauth/device with a client_name), "registration" (POST /oauth/register), "invite" (labels an invite's tokens) */
  origin: "device" | "registration" | "invite";
  confidential: boolean;
  /** "2026-10-16 18:04 UTC" */
  created: string;
  live_tokens: number;
  pending_codes: number;
  live_refresh_tokens: number;
}

const ORIGIN_LABEL: Record<ClientView["origin"], string> = {
  device: "device flow",
  registration: "dynamic registration",
  invite: "invite",
};

/**
 * Clients: every OAuth client the server knows, with what still hangs off it. Remove is enabled only when nothing
 * live remains; the core guard refuses otherwise. The nightly sweep removes orphan device-flow clients by itself.
 */
export function ClientList({ clients, canWrite }: { clients: ClientView[]; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [pending, start] = useTransition();

  const remove = (id: string) => {
    if (pending) return;
    start(async () => {
      const r = await removeClientAction(id);
      setResult(r.ok ? null : r);
      router.refresh();
    });
  };

  if (clients.length === 0) return <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">No clients yet. The first bot or CLI that asks for access registers one.</p>;

  return (
    <div>
      {result && !result.ok && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {result.message}
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {clients.map((c) => {
          const inUse = c.live_tokens > 0 || c.pending_codes > 0 || c.live_refresh_tokens > 0;
          return (
            <li key={c.client_id} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between", !inUse && "opacity-80")}>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{c.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{ORIGIN_LABEL[c.origin]}</span>
                  {c.confidential && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">has secret</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.live_tokens} live token{c.live_tokens === 1 ? "" : "s"} · {c.pending_codes} pending code{c.pending_codes === 1 ? "" : "s"} · {c.live_refresh_tokens} refresh token{c.live_refresh_tokens === 1 ? "" : "s"} · registered {c.created} · <span className="font-mono">{c.client_id}</span>
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => remove(c.client_id)} disabled={!canWrite || pending || inUse} title={inUse ? "Revoke its tokens first" : undefined} aria-label={`Remove client ${c.name}`}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
