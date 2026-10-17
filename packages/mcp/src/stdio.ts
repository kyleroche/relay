/**
 * `relay-mcp`: the stdio server the CLIs talk to. Opens the harness (PGlite locally, Postgres via DATABASE_URL),
 * applies pending migrations, and serves the tools with writes enabled: the process runs as the machine's own user,
 * which is the trust boundary. Logs go to stderr only; stdout is the protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { briefEmbedder, detectGitHub, dispatchEvent, migrate, openAssetStore, openHarness } from "@relay/core";
import { createRelayServer } from "./server.ts";

export async function main(): Promise<void> {
  // The stdio server always serves the machine's own database; a configured site is the CLI's concern.
  const h = await openHarness(undefined, { local: true });
  await migrate(h.db);
  const embed = briefEmbedder(h);
  const actor = `agent:${process.env.RELAY_MCP_CLIENT ?? "mcp"}`;
  // Local store by default: signed file:// URLs the CLI on this machine can read and write directly.
  const github = detectGitHub();
  const server = createRelayServer(h.db, {
    canWrite: true,
    actor,
    assets: { store: openAssetStore() },
    ...(embed ? { embed } : {}),
    ...(github ? { github } : {}),
    // Invites minted here live in this database; the setup line names the site only when this machine has one configured.
    ...(h.cfg.site ? { oauth: { issuer: h.cfg.site } } : {}),
    afterEvent: (row) => dispatchEvent(h.db, row).then(() => undefined),
  });
  const transport = new StdioServerTransport();
  // server.close() closes the transport, which fires server.onclose; the guard keeps the two paths from re-entering.
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    await h.close().catch(() => {});
    process.exit(0);
  };
  server.server.onclose = () => void finish();
  const onSignal = () => void server.close().catch(() => finish());
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await server.connect(transport);
  console.error(`[relay-mcp] serving on stdio (${h.db.driver})`);
}

main().catch((e) => {
  console.error(`[relay-mcp] ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
