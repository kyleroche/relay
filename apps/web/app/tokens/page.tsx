import type { Metadata } from "next";
import Link from "next/link";
import { clientOrigin, listClients, listInvites, listRecentAccess, repo, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES } from "@relay/core";
import { AccessRequests, type RequestView } from "@/components/tokens/access-requests";
import { ClientList, type ClientView } from "@/components/tokens/client-list";
import { InviteCreate, InviteList, type InviteView } from "@/components/tokens/invite-manager";
import { GrantList, MintByHand, type TokenOrigin, type TokenRowView } from "@/components/tokens/token-manager";
import { CopyButton } from "@/components/copy-button";
import { CONNECT_AGENT_PROMPT } from "@/lib/content/info";
import { dataMode, SITE_URL } from "@/lib/data";
import { getDb } from "@/lib/db";
import { oauthOptions } from "@/lib/oauth";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Access",
  description: "Who may call this relay: device requests to approve, the tokens that exist and how they were issued, invites, registered clients, and the by-hand fallback.",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/**
 * Relative time, made once on the server so the markup matches on hydration: "just now", "5 min ago", "2 h ago",
 * "3 d ago", or "in 23 h" for the future. The page is dynamic, so it is fresh on every load.
 */
function rel(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const unit = abs < 60_000 ? null : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"];
  if (!unit) return ms <= 0 ? "just now" : "in under a minute";
  return ms <= 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}
const actorName = (a: string | null): string | null => (a === null ? null : a.replace(/^human:/, ""));

interface Loaded {
  requests: RequestView[];
  tokens: TokenRowView[];
  invites: InviteView[];
  clients: ClientView[];
}

async function load(): Promise<Loaded> {
  const db = await getDb();
  const o = oauthOptions();
  const now = Date.now();
  const [recent, tokens, invites, clients] = await Promise.all([listRecentAccess(db, o), repo.listTokens(db, { includeRevoked: true }), listInvites(db, { includeSpent: true }), listClients(db, o)]);
  const clientName = new Map(clients.map((c) => [c.client_id, c.name]));
  const origin = (t: repo.TokenRow): TokenOrigin => (t.client_id ? { kind: "oauth", client: clientName.get(t.client_id) ?? t.client_id } : t.created_by.startsWith("invite:") ? { kind: "invite" } : { kind: "hand" });
  return {
    requests: recent.map((r) => ({
      user_code: r.user_code,
      client_name: r.client_name,
      scopes: r.scopes,
      state: r.state,
      requested: rel(r.created_at, now),
      expires: rel(r.expires_at, now),
      decided: r.decided_at ? rel(r.decided_at, now) : null,
      decided_by: actorName(r.actor),
      token_name: r.token_name,
    })),
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      created_by: t.created_by,
      created: rel(t.created_at, now),
      last_used: t.last_used_at ? rel(t.last_used_at, now) : null,
      revoked: !!t.revoked_at,
      expired: !!t.expires_at && new Date(t.expires_at).getTime() <= now,
      expires: t.expires_at ? rel(t.expires_at, now) : null,
      origin: origin(t),
    })),
    invites: invites.map((i) => {
      const why = i.revoked_at ? "revoked" : new Date(i.expires_at).getTime() <= now ? "expired" : i.uses_left <= 0 ? "used up" : null;
      return { id: i.id, name: i.name, scopes: i.scopes, uses_left: i.uses_left, max_uses: i.max_uses, expires: rel(i.expires_at, now), created: rel(i.created_at, now), created_by: i.created_by, spent: why !== null, why };
    }),
    clients: clients.map((c) => ({ client_id: c.client_id, name: c.name, origin: clientOrigin(c), confidential: c.has_secret, created: rel(c.created_at, now), live_tokens: c.live_tokens, pending_codes: c.pending_codes, live_refresh_tokens: c.live_refresh_tokens })),
  };
}

const EMPTY: Loaded = { requests: [], tokens: [], invites: [], clients: [] };

/**
 * /tokens, the Access page: what is asking (device requests, with Approve and Deny), what exists (every token and how it
 * was issued), invites when any exist, and the registered clients folded away. The prompt to hand an agent sits at
 * the top; the forms (invite, token by hand) open only from a button beside it. /activate stays the focused approval
 * page a device points a person at.
 */
export default async function AccessPage() {
  await requireSession("/tokens");
  const db = dataMode() === "db";
  const data = db ? await load() : EMPTY;
  const scopes = TOKEN_SCOPES.map((name) => ({ name, description: TOKEN_SCOPE_DESCRIPTIONS[name] }));
  const waiting = data.requests.filter((r) => r.state === "pending" || r.state === "approved").length;
  const live = data.tokens.filter((t) => !t.revoked && !t.expired).length;

  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Access</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Who may call this relay. Agents ask for access themselves and you approve once; tokens renew on their own. Scopes are checked per call (
          <Link href="/docs/api#access" className="underline underline-offset-2 hover:text-foreground">
            how it works
          </Link>
          ).
        </p>
        {!db && <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; access needs a database (RELAY_DATA=db or DATABASE_URL).</p>}
      </section>

      <div className="flex flex-col gap-8">
        <section aria-labelledby="connect-h" className="relative rounded-lg border bg-card p-4">
          <CopyButton text={CONNECT_AGENT_PROMPT} className="absolute right-2 top-2" />
          <div className="pr-10">
            <h2 id="connect-h" className="text-sm font-medium">
              Connect an agent
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Paste this into the bot or coding agent that should use this relay. It asks for access itself; the code shows up under Requests.</p>
          </div>
          <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-foreground">{CONNECT_AGENT_PROMPT}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            <span className="mr-1 text-xs text-muted-foreground">Other ways in:</span>
            <InviteCreate scopes={scopes} canWrite={db} siteUrl={SITE_URL} />
            <MintByHand scopes={scopes} canWrite={db} siteUrl={SITE_URL} />
          </div>
        </section>

        <section aria-labelledby="requests-h">
          <h2 id="requests-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Requests{waiting > 0 && <span className="ml-1 font-mono tabular-nums text-foreground">{waiting}</span>}
          </h2>
          <AccessRequests requests={data.requests} canWrite={db} />
        </section>

        <section aria-labelledby="grants-h">
          <h2 id="grants-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Grants{live > 0 && <span className="ml-1 font-mono tabular-nums text-foreground">{live}</span>}
          </h2>
          <GrantList tokens={data.tokens} canWrite={db} />
        </section>

        {data.invites.length > 0 && (
          <section aria-labelledby="invites-h">
            <h2 id="invites-h" className="mb-2 text-xs font-medium text-muted-foreground">
              Invites
            </h2>
            <InviteList invites={data.invites} canWrite={db} />
          </section>
        )}

        <ClientList clients={data.clients} canWrite={db} />
      </div>
    </>
  );
}
