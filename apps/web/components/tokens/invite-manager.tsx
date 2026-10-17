"use client";

import { Check, Copy, Ticket, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createInviteAction, revokeInviteAction, type TokenActionResult } from "@/app/tokens/actions";
import { ScopePicker, type ScopeOption, toggleIn } from "@/components/tokens/scope-picker";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface InviteView {
  id: string;
  name: string;
  scopes: string[];
  uses_left: number;
  max_uses: number;
  /** "2026-10-17 18:04 UTC" */
  expires: string;
  created: string;
  created_by: string;
  /** Revoked, expired or used up: shown greyed, no Revoke button. */
  spent: boolean;
  /** "revoked" | "expired" | "used up" | null */
  why: string | null;
}

/**
 * Invites: the approval given in advance. The form mints a code shown once with the exact CLI line that redeems it;
 * the list shows live invites with Revoke, and the spent ones under a toggle.
 */
export function InviteManager({ invites, scopes, canWrite, siteUrl }: { invites: InviteView[]; scopes: ScopeOption[]; canWrite: boolean; siteUrl: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [expiresIn, setExpiresIn] = useState("");
  const [uses, setUses] = useState("1");
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSpent, setShowSpent] = useState(false);
  const [pending, start] = useTransition();
  const live = invites.filter((i) => !i.spent);
  const spent = invites.filter((i) => i.spent);
  const cliLine = result?.code ? `relay setup --site ${siteUrl} --invite ${result.code}` : "";

  const create = () => {
    if (pending) return;
    start(async () => {
      const r = await createInviteAction({ name, scopes: [...chosen], expiresIn, uses: Number(uses) || 1 });
      setResult(r);
      setCopied(false);
      if (r.ok) {
        setName("");
        setChosen(new Set());
        router.refresh();
      }
    });
  };

  const revoke = (id: string) => {
    if (pending) return;
    start(async () => {
      const r = await revokeInviteAction(id);
      setResult(r.ok ? null : r);
      router.refresh();
    });
  };

  const copy = async () => {
    if (!cliLine) return;
    try {
      await navigator.clipboard.writeText(cliLine);
      setCopied(true);
    } catch {
      /* the field is selectable */
    }
  };

  const Row = ({ i }: { i: InviteView }) => (
    <li className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between", i.spent && "opacity-60")}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {i.name}
          {i.why && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">{i.why}</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-1">
          {i.scopes.map((s) => (
            <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {s}
            </code>
          ))}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {i.uses_left} of {i.max_uses} use{i.max_uses === 1 ? "" : "s"} left · expires {i.expires} · created {i.created} by {i.created_by} · <span className="font-mono">{i.id}</span>
        </p>
      </div>
      {!i.spent && (
        <Button size="sm" variant="outline" onClick={() => revoke(i.id)} disabled={!canWrite || pending} aria-label={`Revoke invite for ${i.name}`}>
          <Trash2 className="size-3.5" /> Revoke
        </Button>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" disabled={!canWrite}>
              <Ticket className="size-3.5" aria-hidden="true" /> Create an invite
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>Create an invite</SheetTitle>
              <SheetDescription>
                Approval given in advance, for a machine or bot that cannot show you a code: whoever redeems it gets a token named <code className="font-mono">oauth:&lt;name&gt;</code> with exactly these scopes. The code is shown once.
              </SheetDescription>
            </SheetHeader>
        <div className="grid gap-3 px-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">For</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. woodhouse" maxLength={80} disabled={!canWrite || pending} aria-label="Invite name" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Expires in</span>
            <Input value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} placeholder="24h" className="w-24 font-mono" disabled={!canWrite || pending} aria-label="Invite expiry, a duration such as 24h or 7d" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Uses</span>
            <Input type="number" min={1} max={1000} value={uses} onChange={(e) => setUses(e.target.value)} className="w-20 font-mono" disabled={!canWrite || pending} aria-label="Invite uses" />
          </label>
          <Button onClick={create} disabled={!canWrite || pending || !name.trim() || chosen.size === 0}>
            Create invite
          </Button>
        </div>
        <div className="px-4">
          <ScopePicker scopes={scopes} chosen={chosen} onToggle={(s) => setChosen((prev) => toggleIn(prev, s))} disabled={!canWrite || pending} idPrefix="invite" />
        </div>
        {result && !result.ok && (
          <p role="alert" className="px-4 text-xs text-destructive">
            {result.message}
          </p>
        )}
        {result?.ok && result.code && (
          <div role="status" className="mx-4 mb-4 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
            <p className="font-medium">
              Invite for <code className="font-mono">{result.name}</code> created. Send this line now; the code will not be shown again.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded bg-background px-2 py-1.5 font-mono">{cliLine}</code>
              <Button size="sm" variant="outline" onClick={copy} aria-label="Copy the CLI line">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-2 text-muted-foreground">
              Without the CLI: <code className="font-mono">POST {siteUrl}/oauth/token</code> with <code className="font-mono">grant_type=urn:relay:invite&amp;invite=&lt;code&gt;</code>. Closing this panel hides it for good.
            </p>
          </div>
        )}
          </SheetContent>
        </Sheet>
        <span className="text-xs text-muted-foreground">An invite is approval given in advance; most agents should request access instead.</span>
      </div>

      {live.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">No live invites.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {live.map((i) => (
            <Row key={i.id} i={i} />
          ))}
        </ul>
      )}
      {spent.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowSpent((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-expanded={showSpent}>
            {showSpent ? "Hide" : "Show"} {spent.length} used, expired or revoked
          </button>
          {showSpent && (
            <ul className="mt-2 divide-y rounded-lg border">
              {spent.map((i) => (
                <Row key={i.id} i={i} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
