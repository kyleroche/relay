"use client";

import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTokenAction, revokeTokenAction, type TokenActionResult } from "@/app/tokens/actions";
import { ScopePicker, type ScopeOption, toggleIn } from "@/components/tokens/scope-picker";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { ScopeList } from "@/components/ui/scope-list";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** How a token came to exist, resolved on the server from `client_id` and `created_by`. */
export type TokenOrigin = { kind: "oauth"; client: string } | { kind: "invite" } | { kind: "hand" };

export interface TokenRowView {
  id: string;
  name: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
  /** True for an OAuth access token whose 24 h passed (its refresh token may still renew it). */
  expired: boolean;
  /** Expiry of an OAuth token; null for hand-minted ones, which never expire. */
  expires_at: string | null;
  origin: TokenOrigin;
}

const originLabel = (o: TokenOrigin): string => (o.kind === "oauth" ? "device flow" : o.kind === "invite" ? "invite" : "by hand");

/** Grants: live tokens first, revoked and expired ones under a toggle. One line of metadata per row, no identifiers. */
export function GrantList({ tokens, canWrite, now }: { tokens: TokenRowView[]; canWrite: boolean; now: number }) {
  const router = useRouter();
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [pending, start] = useTransition();
  const live = tokens.filter((t) => !t.revoked && !t.expired);
  const past = tokens.filter((t) => t.revoked || t.expired);

  const revoke = (id: string) => {
    if (pending) return;
    start(async () => {
      const r = await revokeTokenAction(id);
      setResult(r.ok ? null : r);
      router.refresh();
    });
  };

  const meta = (t: TokenRowView) => (
    <>
      <span>{originLabel(t.origin)}</span>
      <span>·</span>
      <span>
        created <RelTime iso={t.created_at} now={now} />
      </span>
      <span>·</span>
      {t.revoked ? (
        <span>revoked</span>
      ) : t.expires_at ? (
        <span>
          {t.expired ? "expired" : "expires"} <RelTime iso={t.expires_at} now={now} />
          {!t.expired && ", renews itself"}
        </span>
      ) : (
        <span>never expires</span>
      )}
      <span>·</span>
      {t.last_used_at ? (
        <span>
          used <RelTime iso={t.last_used_at} now={now} />
        </span>
      ) : (
        <span>never used</span>
      )}
    </>
  );

  const Row = ({ t }: { t: TokenRowView }) => (
    <li className={cn("flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between", (t.revoked || t.expired) && "opacity-60")}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium" title={t.id}>
            {t.name}
          </span>
          {t.revoked && <Pill>revoked</Pill>}
          {!t.revoked && t.expired && <Pill>expired</Pill>}
          <ScopeList scopes={t.scopes} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">{meta(t)}</p>
      </div>
      {!t.revoked && (
        <Button size="sm" variant="ghost" onClick={() => revoke(t.id)} disabled={!canWrite || pending} aria-label={`Revoke ${t.name}`}>
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
      {live.length === 0 ? (
        <EmptyState title="No live tokens" as="p">
          Approve a request and its token appears here.
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {live.map((t) => (
            <Row key={t.id} t={t} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <Disclosure label={`${past.length} revoked or expired`} className="mt-2">
          <ul className="divide-y rounded-lg border">
            {past.map((t) => (
              <Row key={t.id} t={t} />
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/**
 * The fallback: mint a token by hand. It is an explicit action (a button that opens a sheet), never a form on the page,
 * because bots and CLIs request access themselves (the Requests section); nothing is preselected and the copy says
 * so. The plaintext appears once, inside the sheet, until it is closed.
 */
export function MintByHand({ scopes, canWrite, siteUrl }: { scopes: ScopeOption[]; canWrite: boolean; siteUrl: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const create = () => {
    if (pending) return;
    start(async () => {
      const r = await createTokenAction(name, [...chosen]);
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
    if (!result?.token) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
    } catch {
      /* the field is selectable */
    }
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" disabled={!canWrite}>
          <KeyRound className="size-3.5" aria-hidden="true" /> Mint a token by hand
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Mint a token by hand</SheetTitle>
          <SheetDescription>
            The fallback for something that cannot run the device flow, such as a CI secret. Bots and CLIs should request access themselves (<code className="font-mono">relay setup --site</code>, or <code className="font-mono">POST /oauth/device</code>) so the token renews and can be traced to a client. A token minted here never expires until you revoke it. The secret is shown once; only its hash is stored.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ci-runner" maxLength={80} disabled={!canWrite || pending} aria-label="Token name" />
        </label>
        <Button onClick={create} disabled={!canWrite || pending || !name.trim() || chosen.size === 0}>
          Create token
        </Button>
      </div>
        <div className="px-4">
          <ScopePicker scopes={scopes} chosen={chosen} onToggle={(s) => setChosen((prev) => toggleIn(prev, s))} disabled={!canWrite || pending} idPrefix="mint" />
        </div>
        {result && !result.ok && (
          <p role="alert" className="px-4 text-xs text-destructive">
            {result.message}
          </p>
        )}
        {result?.ok && result.token && (
          <div role="status" className="mx-4 mb-4 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
          <p className="font-medium">
            Token <code className="font-mono">{result.name}</code> created. Copy it now; it will not be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded bg-background px-2 py-1.5 font-mono">{result.token}</code>
            <Button size="sm" variant="outline" onClick={copy} aria-label="Copy token">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2 text-muted-foreground">
            CLI: <code className="font-mono">relay setup --site {siteUrl} --token &lt;paste&gt;</code>. Bots: <code className="font-mono">Authorization: Bearer &lt;paste&gt;</code> against <code className="font-mono">{siteUrl}/api/v1</code> and <code className="font-mono">{siteUrl}/mcp</code>. Closing this panel hides it for good.
          </p>
        </div>
      )}
      </SheetContent>
    </Sheet>
  );
}
