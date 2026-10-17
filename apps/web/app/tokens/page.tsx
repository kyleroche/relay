import type { Metadata } from "next";
import Link from "next/link";
import { repo, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES } from "@relay/core";
import { TokenManager, type TokenRowView } from "@/components/tokens/token-manager";
import { dataMode, SITE_URL } from "@/lib/data";
import { getDb } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Tokens",
  description: "Bearer tokens for the relay API and MCP server: create with scopes, list, revoke. The secret is shown once.",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/** Preselected for the common case: an external chief-of-staff bot that opens tasks, reads their state and logs its own events. */
const BOT_PRESET = ["tasks:read", "tasks:write", "events:write"];

export default async function TokensPage() {
  await requireSession("/tokens");
  const db = dataMode() === "db";
  const tokens: TokenRowView[] = db ? await repo.listTokens(await getDb(), { includeRevoked: true }) : [];
  const scopes = TOKEN_SCOPES.map((name) => ({ name, description: TOKEN_SCOPE_DESCRIPTIONS[name] }));

  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Tokens</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Bearer tokens for <code className="font-mono">/api/v1</code> and <code className="font-mono">/mcp</code>. The first token for a new site is minted here; after that the CLI can mint more in site mode (<code className="font-mono">relay token create</code>). Scopes are checked per call; see{" "}
          <Link href="/docs/api" className="underline underline-offset-2 hover:text-foreground">
            API and MCP
          </Link>{" "}
          and{" "}
          <Link href="/docs/integrations" className="underline underline-offset-2 hover:text-foreground">
            Integrations
          </Link>
          .
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Bots can request access themselves: they ask at <code className="font-mono">/oauth/device</code>, you approve a code on{" "}
          <Link href="/activate" className="underline underline-offset-2 hover:text-foreground">
            Activate
          </Link>{" "}
          (or hand out an invite with <code className="font-mono">relay invite create</code>); see{" "}
          <Link href="/docs/api#access" className="underline underline-offset-2 hover:text-foreground">
            /docs/api#access
          </Link>
          . The form below is the fallback for minting a token by hand.
        </p>
        {!db && <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; tokens need a database (RELAY_DATA=db or DATABASE_URL).</p>}
      </section>
      <TokenManager tokens={tokens} scopes={scopes} preset={BOT_PRESET} canWrite={db} siteUrl={SITE_URL} />
    </>
  );
}
