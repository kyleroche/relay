"use client";

import { Check, Copy, Ticket, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createInviteAction, revokeInviteAction, type TokenActionResult } from "@/app/access/actions";
import { ScopePicker, type ScopeOption, toggleIn } from "@/components/tokens/scope-picker";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { ScopeList } from "@/components/ui/scope-list";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface InviteView {
  id: string;
  name: string;
  scopes: string[];
  uses_left: number;
  max_uses: number;
  expires_at: string;
  created_at: string;
  created_by: string;
  /** Revoked, expired or used up: shown greyed, no Revoke button. */
  spent: boolean;
  /** "revoked" | "expired" | "used up" | null */
  why: string | null;
}

/**
 * Create an invite: an explicit action that opens a sheet. The code is shown once, with the CLI line that redeems it,
 * and disappears when the sheet closes.
 */
export function InviteCreate({ scopes, canWrite, siteUrl }: { scopes: ScopeOption[]; canWrite: boolean; siteUrl: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [expiresIn, setExpiresIn] = useState("");
  const [uses, setUses] = useState("1");
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
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

  const copy = async () => {
    if (!cliLine) return;
    try {
      await navigator.clipboard.writeText(cliLine);
      setCopied(true);
    } catch {
      /* the field is selectable */
    }
  };

  return (
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
            Approval given in advance, for a machine or bot that cannot show you a code. Whoever redeems it gets a token named <code className="font-mono">oauth:&lt;name&gt;</code> with exactly these scopes. The code is shown once.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 px-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
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
        </div>
        <div className="px-4">
          <ScopePicker scopes={scopes} chosen={chosen} onToggle={(s) => setChosen((prev) => toggleIn(prev, s))} disabled={!canWrite || pending} idPrefix="invite" />
        </div>
        <div className="px-4">
          <Button onClick={create} disabled={!canWrite || pending || !name.trim() || chosen.size === 0}>
            Create invite
          </Button>
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
  );
}

/** Invites that exist: live ones with Revoke, the spent ones under a toggle. Renders nothing when there are none. */
export function InviteList({ invites, canWrite, now }: { invites: InviteView[]; canWrite: boolean; now: number }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [pending, start] = useTransition();
  const live = invites.filter((i) => !i.spent);
  const spent = invites.filter((i) => i.spent);

  const revoke = (id: string) => {
    if (pending) return;
    start(async () => {
      const r = await revokeInviteAction(id);
      setResult(r.ok ? null : r);
      router.refresh();
    });
  };

  if (invites.length === 0) return null;

  const Row = ({ i }: { i: InviteView }) => (
    <li className={cn("flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between", i.spent && "opacity-60")}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium" title={i.id}>
            {i.name}
          </span>
          {i.why && <Pill>{i.why}</Pill>}
          <ScopeList scopes={i.scopes} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          {!i.spent && (
            <>
              <span>
                {i.uses_left} of {i.max_uses} use{i.max_uses === 1 ? "" : "s"} left
              </span>
              <span>·</span>
              <span>
                expires <RelTime iso={i.expires_at} now={now} />
              </span>
              <span>·</span>
            </>
          )}
          <span>
            created <RelTime iso={i.created_at} now={now} />
          </span>
        </p>
      </div>
      {!i.spent && (
        <Button size="sm" variant="ghost" className="hover:text-destructive" onClick={() => revoke(i.id)} disabled={!canWrite || pending} aria-label={`Revoke invite for ${i.name}`}>
          <Trash2 className="size-3.5" /> Revoke
        </Button>
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
      {live.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {live.map((i) => (
            <Row key={i.id} i={i} />
          ))}
        </ul>
      )}
      {spent.length > 0 && (
        <Disclosure label={`${spent.length} used, expired or revoked`} className={live.length > 0 ? "mt-2" : ""}>
          <ul className="divide-y rounded-lg border">
            {spent.map((i) => (
              <Row key={i.id} i={i} />
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
