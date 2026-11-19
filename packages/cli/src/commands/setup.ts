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
  board,
  loadConfig,
  writeBoardConfig,
} from "@relay/core";
import { log, RELAY_ROOT } from "./_common.ts";

/** What this machine's CLI and hooks need: everything but reviewing assets and minting tokens, unless asked. */
export const DEFAULT_CLI_SCOPES = TOKEN_SCOPES.filter((s) => s !== "assets:review" && s !== "tokens:write");

export const defaultClientName = (): string => `relay-cli@${hostname().split(".")[0] || "machine"}`;

interface SetupOpts {
  yes?: boolean;
  only?: string;
  remove?: boolean;
  /** commander: `--no-statusline` sets false; absent means true. */
  statusline?: boolean;
  site?: string | boolean;
  token?: string;
  invite?: string;
  scopes?: string;
  name?: string;
  board?: boolean;
  team?: string;
  boardName?: string;
  from?: string;
  create?: boolean;
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install session hooks, the relay MCP server and (Claude Code) the plan-meter status line into Claude Code, Codex and Grok Build configs (plan only without --yes); --site connects this machine to a hosted relay")
    .option("--yes", "write the planned files")
    .option("--only <cli>", "claude | codex | grok (installs even when the CLI is not detected)")
    .option("--remove", "remove relay's hooks, status line and MCP entries instead (a status line relay replaced is restored)")
    .option("--no-statusline", "do not install relay's Claude Code status line (it saves the plan meters Claude Code reports to ~/.harness/meters; the web app's header needs them)")
    .option("--site <url>", "site mode: the hosted relay the CLI and hooks talk to instead of a local database (stored in ~/.harness/config.json). Without --token or --invite, runs the device flow: approve the printed code at <site>/activate")
    .option("--invite <code>", "redeem an invite code from `relay invite create` for the token (no approval step)")
    .option("--token <token>", "paste a bearer token minted at <site>/tokens or with relay token create (stored in ~/.harness/credentials.json, mode 0600)")
    .option("--scopes <list>", `scopes to ask for in the device flow (default: ${DEFAULT_CLI_SCOPES.join(",")})`)
    .option("--name <client-name>", `how this machine appears on the consent page and in the token's name (default: ${defaultClientName()})`)
    .option("--no-site", "leave site mode: remove the site and its token; the CLI opens the local database again")
    .option("--board", "set this machine up on the team's Vercel Board: save which board it works from, check this machine's Vercel login on it, and register relay's schemas there")
    .option("--team <id-or-slug>", "with --board: the Vercel team that owns the board (default: the login's default team)")
    .option("--board-name <name>", "with --board: a named board of that team instead of its default one ('default' goes back)")
    .option("--create", "with --board and --board-name: make the named board if the team does not have it")
    .option("--from <actors>", "with --board: whose tasks a worker here claims besides your own, as comma-separated actor IDs ('none' clears it), such as the project that runs relay's site")
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
      if (o.board) {
        await connectToBoard(o);
        return;
      }
      const siteCfg = readSiteConfig();
      if (siteCfg.site) console.log(`site mode: ${siteCfg.site}${siteCfg.token ? ` (token from ${siteCfg.tokenSource ?? "file"})` : " (no token; run relay setup --site <url>)"}\n`);
      const ctx = defaultHookContext(RELAY_ROOT);
      const plans = planSetup(ctx, { ...(o.only ? { only: o.only as CliName } : {}), ...(o.remove ? { remove: true } : {}), statusline: o.statusline !== false });
      let pending = 0;
      for (const p of plans) {
        console.log(`\n${p.cli}${p.detected ? "" : " (not detected)"}`);
        for (const f of p.files) {
          console.log(`  ${f.action.padEnd(9)} ${f.path}`);
          if (f.action !== "unchanged") pending++;
        }
        for (const n of p.notes) console.log(`  note: ${n}`);
      }
      const mcpNote = siteCfg.site ? `memory MCP server: forwards to ${siteCfg.site} in site mode; local database otherwise` : "memory MCP server: local database (no site configured; it forwards to the site once relay setup --site <url> has run)";
      console.log(`\nhook scripts: ${join(RELAY_ROOT, "packages", "cli", "hooks")}\nMCP entry:    ${join(RELAY_ROOT, "packages", "mcp", "bin", "relay-mcp.mjs")}\n              ${mcpNote}\nnode:         ${ctx.node}`);
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

/**
 * `relay setup --board`: there is no token to fetch, since the board takes this machine's own `vercel login`. What is
 * saved is which board and whose tasks; what is checked is that the login reaches it; and relay's schemas are
 * registered, which is the one step that needs someone who manages the board.
 */
async function connectToBoard(o: SetupOpts): Promise<void> {
  const from = o.from === undefined ? undefined : o.from === "none" ? null : o.from.split(",").map((a) => a.trim()).filter(Boolean);
  if (o.team !== undefined || o.boardName !== undefined || from !== undefined) {
    const w = writeBoardConfig({ ...(o.team !== undefined ? { team: o.team } : {}), ...(o.boardName !== undefined ? { name: o.boardName === "default" ? null : o.boardName } : {}), ...(from !== undefined ? { from } : {}) });
    log(`wrote the board entry of ${w.configPath}: ${JSON.stringify(w.board)}`);
  }
  const cfg = loadConfig().board;
  let session: board.BoardSession;
  try {
    const handle = board.openBoard(cfg, { create: !!o.create });
    // a named board is made by its first use, so one harmless read is what creates it
    if (o.create && cfg.name) await handle.channels();
    session = await board.connectBoard(handle, cfg);
  } catch (e) {
    throw new Error(`cannot reach the board: ${board.describeBoardError(e)}. The board takes this machine's own Vercel login: run vercel login (Vercel CLI 66 or newer), then relay setup --board again.`);
  }
  const { url, name } = await session.board.discovery();
  console.log(`board:   ${name ?? "General"} at ${url}`);
  console.log(`you:     ${session.me.handle} (${session.me.principal})`);
  console.log(`can:     ${Object.entries(session.me.can ?? {}).map(([pattern, what]) => `${pattern} = ${Array.isArray(what) ? what.join(",") : String(what)}`).join("; ") || "nothing"}`);
  console.log(`from:    ${session.from.join(", ")}`);
  const registered = await board.ensureSchemas(session.board);
  console.log(`schemas: ${registered ? "relay's schemas are registered" : "this login cannot register schemas (it takes `manage` everywhere): ask someone who manages the board to run relay setup --board"}`);
  log("next: relay work --once to drain the queue here, or relay work --install --yes to keep a worker running");
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
    } else {
      if (typeof o.site === "string" && current.token && current.site === site.replace(/\/+$/, "")) {
        // same site, token already here: keep it when the site still accepts it; otherwise (revoked, expired past its
        // refresh) fall through to a fresh device flow instead of saving a dead credential
        const existing = await httpClient({ site, token: current.token }).health();
        if (existing.ok) {
          credential = { token: current.token, refreshToken: current.refreshToken ?? null, expiresAt: current.tokenExpiresAt ?? null, source: current.tokenSource ?? "manual", tokenName: current.tokenName ?? null };
        } else log(`the stored token no longer works (${existing.detail}); asking for access again`);
      }
    }
    if (!credential && !fromResponse) {
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
  log(`site mode on: ${site} (${paths.configPath}); memory, feed, token, invite, task and webhook commands, the hooks and the stdio MCP server now use the site. relay link still digests locally and uploads.`);
}
