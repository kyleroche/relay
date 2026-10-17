/**
 * `relay-mcp`: the stdio server the CLIs talk to. It follows the machine's mode, the same one the CLI and the hooks
 * use (`~/.harness/config.json` `site` plus a credential in `credentials.json`, or RELAY_SITE/RELAY_TOKEN):
 *
 *   site mode   a pass-through to `<site>/mcp` (bridge.ts): the tools, their descriptions and every answer are the
 *               site's, sent with this machine's bearer token, which is renewed through the device-flow refresh
 *               before it lapses and once more if the site refuses it. No database is opened.
 *   local mode  opens the harness (PGlite locally, Postgres via DATABASE_URL), applies pending migrations, and
 *               serves the tools with writes enabled: the process runs as the machine's own user, which is the trust
 *               boundary.
 *
 * Logs go to stderr only; stdout is the protocol. The first stderr line names the mode.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { briefEmbedder, detectGitHub, dispatchEvent, ensureHome, loadConfig, migrate, openAssetStore, openHarness, refreshSiteTokenIfStale, type HarnessConfig } from "@relay/core";
import { createSiteBridge, serveSiteBridge, siteAuth, tokenLabel } from "./bridge.ts";
import { createRelayServer } from "./server.ts";

const log = (m: string) => console.error(`relay-mcp: ${m}`);
const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function serveSite(cfg: HarnessConfig): Promise<void> {
  const site = cfg.site!;
  // A failed refresh at start is not fatal: each request then answers with the same message, and the CLI shows it.
  try {
    cfg = await refreshSiteTokenIfStale(cfg);
  } catch (e) {
    log(describe(e));
  }
  const bridge = createSiteBridge({ site, auth: siteAuth(cfg), log });
  const transport = new StdioServerTransport();
  const served = await serveSiteBridge(transport, bridge, (e) => log(describe(e)));
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    await served.drain();
    await transport.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", () => void finish());
  process.on("SIGINT", () => void finish());
  process.on("SIGTERM", () => void finish());
  log(`site mode, forwarding to ${site} as ${tokenLabel(cfg)}`);
}

async function serveLocal(cfg: HarnessConfig): Promise<void> {
  const h = await openHarness(cfg, { local: true });
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
  log(`local mode, ${h.db.driver === "pg" ? "postgres via DATABASE_URL" : cfg.dbFile}`);
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureHome(cfg);
  if (cfg.site && cfg.siteToken) await serveSite(cfg);
  else await serveLocal(cfg);
}

main().catch((e) => {
  console.error(`relay-mcp: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
