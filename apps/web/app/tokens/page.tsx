import type { Metadata } from "next";
import Link from "next/link";
import { clientOrigin, listClients, listInvites, listRecentAccess, repo, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES } from "@relay/core";
import { AccessRequests, type RequestView } from "@/components/tokens/access-requests";
import { ClientList, type ClientView } from "@/components/tokens/client-list";
import { InviteManager, type InviteView } from "@/components/tokens/invite-manager";
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

/** "2026-10-16 18:04 UTC": fixed zone so the server and the browser render the same string. */
const utc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;
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
      requested: utc(r.created_at),
      expires: utc(r.expires_at),
      decided: r.decided_at ? utc(r.decided_at) : null,
      decided_by: actorName(r.actor),
      token_name: r.token_name,
    })),
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      created_by: t.created_by,
      created: t.created_at.slice(0, 10),
      last_used: t.last_used_at ? utc(t.last_used_at) : null,
      revoked: !!t.revoked_at,
      expired: !!t.expires_at && new Date(t.expires_at).getTime() <= now,
      expires: t.expires_at ? utc(t.expires_at) : null,
      origin: origin(t),
    })),
    invites: invites.map((i) => {
      const why = i.revoked_at ? "revoked" : new Date(i.expires_at).getTime() <= now ? "expired" : i.uses_left <= 0 ? "used up" : null;
      return { id: i.id, name: i.name, scopes: i.scopes, uses_left: i.uses_left, max_uses: i.max_uses, expires: utc(i.expires_at), created: i.created_at.slice(0, 10), created_by: i.created_by, spent: why !== null, why };
    }),
    clients: clients.map((c) => ({ client_id: c.client_id, name: c.name, origin: clientOrigin(c), confidential: c.has_secret, created: utc(c.created_at), live_tokens: c.live_tokens, pending_codes: c.pending_codes, live_refresh_tokens: c.live_refresh_tokens })),
  };
}

const EMPTY: Loaded = { requests: [], tokens: [], invites: [], clients: [] };

/**
 * /tokens, the Access page: what is asking (device requests, with Approve and Deny), what exists (every token and how it
 * was issued), what is promised (invites), who is registered (clients), and the prompt to hand an agent so it connects
 * by itself. Forms (invite, token by hand) open only from an explicit button. /activate stays the focused approval
 * page a device points a person at.
 */
export default async function AccessPage() {
  await requireSession("/tokens");
  const db = dataMode() === "db";
  const data = db ? await load() : EMPTY;
  const scopes = TOKEN_SCOPES.map((name) => ({ name, description: TOKEN_SCOPE_DESCRIPTIONS[name] }));
  const waiting = data.requests.filter((r) => r.state === "pending").length;
  const live = data.tokens.filter((t) => !t.revoked && !t.expired).length;

  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Access</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Who may call <code className="font-mono">/api/v1</code> and <code className="font-mono">/mcp</code>. Bots and CLIs ask for access themselves (<code className="font-mono">POST /oauth/device</code>, or <code className="font-mono">relay setup --site</code>); you approve the code here or on{" "}
          <Link href="/activate" className="underline underline-offset-2 hover:text-foreground">
            /activate
          </Link>
          , and the token they receive lasts 24 hours and renews itself for 90 days. Invites are approval given in advance. Scopes are checked per call; see{" "}
          <Link href="/docs/api#access" className="underline underline-offset-2 hover:text-foreground">
            how agents get access
          </Link>{" "}
          and{" "}
          <Link href="/docs/integrations" className="underline underline-offset-2 hover:text-foreground">
            Integrations
          </Link>
          .
        </p>
        {!db && <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; access needs a database (RELAY_DATA=db or DATABASE_URL).</p>}
      </section>

      <div className="flex flex-col gap-10">
        <section aria-labelledby="requests-h">
          <h2 id="requests-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Requests {waiting > 0 && <span className="font-mono tabular-nums">{waiting} waiting</span>}
          </h2>
          <AccessRequests requests={data.requests} canWrite={db} />
        </section>

        <section aria-labelledby="grants-h">
          <h2 id="grants-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Grants <span className="font-mono tabular-nums">{live}</span> live
          </h2>
          <GrantList tokens={data.tokens} canWrite={db} />
        </section>

        <section aria-labelledby="invites-h">
          <h2 id="invites-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Invites
          </h2>
          <InviteManager invites={data.invites} scopes={scopes} canWrite={db} siteUrl={SITE_URL} />
        </section>

        <section aria-labelledby="clients-h">
          <h2 id="clients-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Clients <span className="font-mono tabular-nums">{data.clients.length}</span>
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">Every OAuth client the server has registered. A client with nothing live can be removed; the nightly sweep removes device-flow clients that never got a token.</p>
          <ClientList clients={data.clients} canWrite={db} />
        </section>

        <section aria-labelledby="connect-h">
          <h2 id="connect-h" className="mb-2 text-xs font-medium text-muted-foreground">
            Connect an agent
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">Paste this into the bot or coding agent that should use this relay. It asks for access itself; you approve the code under Requests.</p>
          <div className="relative">
            <pre className="whitespace-pre-wrap break-words rounded-md border bg-card p-4 pr-12 text-[13px] leading-6">
              <code className="language-text">{CONNECT_AGENT_PROMPT}</code>
            </pre>
            <CopyButton text={CONNECT_AGENT_PROMPT} className="absolute right-2 top-2" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <MintByHand scopes={scopes} canWrite={db} siteUrl={SITE_URL} />
            <span className="text-xs text-muted-foreground">Only for something that cannot run the device flow, such as a CI secret.</span>
          </div>
        </section>
      </div>
    </>
  );
}
