/**
 * `relay setup`: install hooks and the memory MCP server into each detected CLI (plans first, writes with --yes), and
 * put this machine in site mode. Site mode without a token runs the device flow: the command prints a code, the person
 * approves it at <site>/activate (or a bot approves it over the API), and the token lands in credentials.json with its
 * refresh token. `--invite <code>` redeems an invite instead, with no approval. `--token <t>` still pastes one by hand.
 */
import type { Command } from "commander";
import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyPlan,
  credentialsFromToken,
  defaultHookContext,
  deviceFlow,
  httpClient,
  OAuthClientError,
  planSetup,
  readSiteConfig,
  redeemInvite,
  TOKEN_SCOPES,
  validateSiteUrl,
  writeSiteConfig,
  CLI_NAMES,
  type CliName,
  type OAuthTokenResponse,
  type SiteCredential,
} from "@relay/core";
import { log, RELAY_ROOT } from "./_common.ts";

/** What this machine's CLI and hooks need: everything but reviewing assets and minting tokens, unless asked. */
export const DEFAULT_CLI_SCOPES = TOKEN_SCOPES.filter((s) => s !== "assets:review" && s !== "tokens:write");

export const defaultClientName = (): string => `relay-cli@${hostname().split(".")[0] || "machine"}`;

interface SetupOpts {
  yes?: boolean;
  only?: string;
  remove?: boolean;
  site?: string | boolean;
  token?: string;
  invite?: string;
  scopes?: string;
  name?: string;
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install session hooks and the relay MCP server into Claude Code, Codex and Grok Build configs (plan only without --yes); --site connects this machine to a hosted relay")
    .option("--yes", "write the planned files")
    .option("--only <cli>", "claude | codex | grok (installs even when the CLI is not detected)")
    .option("--remove", "remove relay's hooks and MCP entries instead")
    .option("--site <url>", "site mode: the hosted relay the CLI and hooks talk to instead of a local database (stored in ~/.harness/config.json). Without --token or --invite, runs the device flow: approve the printed code at <site>/activate")
    .option("--invite <code>", "redeem an invite code from `relay invite create` for the token (no approval step)")
    .option("--token <token>", "paste a bearer token minted at <site>/tokens or with relay token create (stored in ~/.harness/credentials.json, mode 0600)")
    .option("--scopes <list>", `scopes to ask for in the device flow (default: ${DEFAULT_CLI_SCOPES.join(",")})`)
    .option("--name <client-name>", `how this machine appears on the consent page and in the token's name (default: ${defaultClientName()})`)
    .option("--no-site", "leave site mode: remove the site and its token; the CLI opens the local database again")
    .action(async (o: SetupOpts) => {
      if (o.only && !(CLI_NAMES as readonly string[]).includes(o.only)) throw new Error(`--only must be one of ${CLI_NAMES.join(", ")}`);
      // --- site mode ---
      if (o.site === false) {
        const paths = writeSiteConfig({ site: null, token: null });
        log(`site mode off: removed site from ${paths.configPath} and the token from ${paths.credentialsPath}`);
        return;
      }
      if (typeof o.site === "string" || o.token || o.invite) {
        await connectSite(o);
        return;
      }
      const siteCfg = readSiteConfig();
      if (siteCfg.site) console.log(`site mode: ${siteCfg.site}${siteCfg.token ? ` (token from ${siteCfg.tokenSource ?? "file"})` : " (no token; run relay setup --site <url>)"}\n`);
      const ctx = defaultHookContext(RELAY_ROOT);
      const plans = planSetup(ctx, { ...(o.only ? { only: o.only as CliName } : {}), ...(o.remove ? { remove: true } : {}) });
      let pending = 0;
      for (const p of plans) {
        console.log(`\n${p.cli}${p.detected ? "" : " (not detected)"}`);
        for (const f of p.files) {
          console.log(`  ${f.action.padEnd(9)} ${f.path}`);
          if (f.action !== "unchanged") pending++;
        }
        for (const n of p.notes) console.log(`  note: ${n}`);
      }
      console.log(`\nhook scripts: ${join(RELAY_ROOT, "packages", "cli", "hooks")}\nMCP entry:    ${join(RELAY_ROOT, "packages", "mcp", "bin", "relay-mcp.mjs")}\nnode:         ${ctx.node}`);
      const major = Number(process.versions.node.split(".")[0]);
      if (major < 24) console.log(`note: hooks will run with Node ${process.versions.node}; relay pins Node 24. Run this through \`pnpm relay setup\` so the pinned binary is recorded instead.`);
      if (!pending) {
        console.log("\nnothing to change");
        return;
      }
      if (!o.yes) {
        console.log(`\n${pending} file(s) would change; re-run with --yes to write them`);
        return;
      }
      mkdirSync(join(ctx.relayHome, "cache"), { recursive: true });
      for (const p of plans) for (const w of applyPlan(p)) log(`wrote ${w}`);
    });
}

/** `relay setup --site <url> [--token t | --invite c | (device flow)]`. */
async function connectSite(o: SetupOpts): Promise<void> {
  const current = readSiteConfig();
  const site = typeof o.site === "string" ? o.site : current.site;
  if (!site) throw new Error("--token and --invite need --site <url> (or a site already configured)");
  const bad = validateSiteUrl(site);
  if (bad) throw new Error(bad);
  const clientName = o.name?.trim() || defaultClientName();
  const scopes = o.scopes ? o.scopes.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_CLI_SCOPES];

  let credential: SiteCredential | undefined;
  let fromResponse: OAuthTokenResponse | undefined;
  try {
    if (o.token) {
      credential = { token: o.token, source: "manual" };
    } else if (o.invite) {
      log(`redeeming the invite at ${site}…`);
      fromResponse = await redeemInvite({ site, code: o.invite, clientName });
    } else if (typeof o.site === "string" && current.token && current.site === site.replace(/\/+$/, "")) {
      // same site, token already here: just re-check and save the URL
      credential = { token: current.token, refreshToken: current.refreshToken ?? null, expiresAt: current.tokenExpiresAt ?? null, source: current.tokenSource ?? "manual", tokenName: current.tokenName ?? null };
    } else {
      log(`asking ${site} for access as ${clientName} (${scopes.join(", ")})`);
      fromResponse = await deviceFlow({
        site,
        clientName,
        scopes,
        onPrompt: (p) => {
          const minutes = Math.round(p.expires_in / 60);
          console.log(`\n  Open ${p.verification_uri_complete}\n  and approve code ${p.user_code} (valid ${minutes} minutes).\n\n  Not at a browser? Any relay bot with tokens:write can approve it:\n  POST ${site}/api/v1/access/${p.user_code}/approve\n`);
          log("waiting for the approval…");
        },
      });
    }
  } catch (e) {
    if (e instanceof OAuthClientError) throw new Error(`${site} refused (${e.code}): ${e.description}`);
    throw e;
  }
  if (fromResponse) {
    const c = credentialsFromToken(fromResponse);
    credential = { token: c.token, refreshToken: c.refreshToken, expiresAt: c.expiresAt, source: o.invite ? "invite" : "device", tokenName: fromResponse.token_name ?? null };
    log(`received token ${fromResponse.token_name ?? ""} (${fromResponse.scope ?? scopes.join(" ")})${c.expiresAt ? `, renews itself until the refresh token expires` : ""}`);
  }
  if (!credential) throw new Error("no credential obtained");

  const probe = await httpClient({ site, token: credential.token }).health();
  if (!probe.ok) {
    log(`check failed: ${probe.detail}`);
    if (!o.yes) throw new Error("site not saved; fix the URL or token, or re-run with --yes to save anyway");
  } else log(`check: ${probe.detail}`);
  const paths = writeSiteConfig({ site, token: credential });
  log(`credential saved to ${paths.credentialsPath} (mode 0600, source: ${credential.source})`);
  log(`site mode on: ${site} (${paths.configPath}); memory, feed, token, invite, task and webhook commands and the hooks now use the site. relay link still digests locally and uploads.`);
}
