"use client";

import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTokenAction, revokeTokenAction, type TokenActionResult } from "@/app/tokens/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface TokenRowView {
  id: string;
  name: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface Props {
  tokens: TokenRowView[];
  scopes: Array<{ name: string; description: string }>;
  /** Preselected scopes for the common case (an external bot). */
  preset: string[];
  canWrite: boolean;
  siteUrl: string;
}

/** Create with scope checkboxes, list, revoke. The plaintext appears once, under the form, until the page is left. */
export function TokenManager({ tokens, scopes, preset, canWrite, siteUrl }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set(preset));
  const [result, setResult] = useState<TokenActionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const toggle = (s: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const create = () => {
    if (pending) return;
    start(async () => {
      const r = await createTokenAction(name, [...chosen]);
      setResult(r);
      setCopied(false);
      if (r.ok) {
        setName("");
        router.refresh();
      }
    });
  };

  const revoke = (id: string) => {
    if (pending) return;
    start(async () => {
      const r = await revokeTokenAction(id);
      setResult(r.ok ? null : r);
      router.refresh();
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
    <div className="flex flex-col gap-8">
      <section aria-labelledby="new-token-h" className="rounded-lg border p-4 sm:p-5">
        <h2 id="new-token-h" className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4" aria-hidden="true" /> New token
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">Name it after the thing that will hold it. The secret is shown once, right here; only its hash is stored.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="grok-bot" maxLength={80} disabled={!canWrite || pending} aria-label="Token name" />
          </label>
          <Button onClick={create} disabled={!canWrite || pending || !name.trim() || chosen.size === 0}>
            Create token
          </Button>
        </div>
        <fieldset className="mt-4">
          <legend className="text-xs text-muted-foreground">Scopes</legend>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {scopes.map((s) => (
              <li key={s.name}>
                <label className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors hover:bg-accent/50", chosen.has(s.name) && "border-primary/60 bg-primary/5")}>
                  <input type="checkbox" className="mt-0.5 accent-primary" checked={chosen.has(s.name)} onChange={() => toggle(s.name)} disabled={!canWrite || pending} />
                  <span className="min-w-0">
                    <code className="font-mono">{s.name}</code>
                    <span className="block text-muted-foreground">{s.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {result && !result.ok && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {result.message}
          </p>
        )}
        {result?.ok && result.token && (
          <div role="status" className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
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
              CLI: <code className="font-mono">relay setup --site {siteUrl} --token &lt;paste&gt;</code>. Bots: <code className="font-mono">Authorization: Bearer &lt;paste&gt;</code> against <code className="font-mono">{siteUrl}/api/v1</code> and <code className="font-mono">{siteUrl}/mcp</code>.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="tokens-h">
        <h2 id="tokens-h" className="mb-2 text-xs font-medium text-muted-foreground">
          Tokens <span className="font-mono tabular-nums">{tokens.length}</span>
        </h2>
        {tokens.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No tokens yet. The first one you create is the one you give the CLI or a bot.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {tokens.map((t) => (
              <li key={t.id} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between", t.revoked_at && "opacity-60")}>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {t.name}
                    {t.revoked_at && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">revoked</span>}
                  </p>
                  <p className="mt-0.5 flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {s}
                      </code>
                    ))}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    created {t.created_at.slice(0, 10)} by {t.created_by} · last used {t.last_used_at ? t.last_used_at.slice(0, 16).replace("T", " ") : "never"} · <span className="font-mono">{t.id}</span>
                  </p>
                </div>
                {!t.revoked_at && (
                  <Button size="sm" variant="outline" onClick={() => revoke(t.id)} disabled={!canWrite || pending} aria-label={`Revoke ${t.name}`}>
                    <Trash2 className="size-3.5" /> Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
