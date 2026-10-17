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
  /** Relative, made on the server: "2 h ago" */
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
 * Clients: every OAuth client the server knows, folded away because they are plumbing. Remove is enabled only when
 * nothing live remains (the core guard refuses otherwise); the nightly sweep removes idle device-flow clients itself.
 */
export function ClientList({ clients, canWrite }: { clients: ClientView[]; canWrite: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const idle = clients.filter((c) => c.live_tokens === 0 && c.pending_codes === 0 && c.live_refresh_tokens === 0).length;

  const remove = (id: string) => {
    if (pending) return;
    start(async () => {
      const r = await removeClientAction(id);
      setResult(r.ok ? null : r);
      router.refresh();
    });
  };

  if (clients.length === 0) return null;

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-expanded={open}>
        {open ? "Hide" : "Show"} {clients.length} registered client{clients.length === 1 ? "" : "s"}
        {idle > 0 ? `, ${idle} idle` : ""}
      </button>
      {open && (
        <div className="mt-2">
          {result && !result.ok && (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {result.message}
            </p>
          )}
          <ul className="divide-y rounded-lg border">
            {clients.map((c) => {
              const inUse = c.live_tokens > 0 || c.pending_codes > 0 || c.live_refresh_tokens > 0;
              const parts = [ORIGIN_LABEL[c.origin], `registered ${c.created}`];
              if (c.confidential) parts.push("has a secret");
              parts.push(inUse ? [c.live_tokens && `${c.live_tokens} live token${c.live_tokens === 1 ? "" : "s"}`, c.pending_codes && `${c.pending_codes} pending code${c.pending_codes === 1 ? "" : "s"}`].filter(Boolean).join(", ") || "renewing" : "idle");
              return (
                <li key={c.client_id} className={cn("flex items-center justify-between gap-3 px-3 py-2", !inUse && "opacity-70")}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium" title={c.client_id}>
                      {c.name}
                    </p>
                    <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => remove(c.client_id)} disabled={!canWrite || pending || inUse} title={inUse ? "Revoke its tokens first" : undefined} aria-label={`Remove client ${c.name}`}>
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
