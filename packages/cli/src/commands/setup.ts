/** `relay setup`: install hooks and the memory MCP server into each detected CLI. Plans first, writes with --yes. */
import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, defaultHookContext, httpClient, planSetup, readSiteConfig, validateSiteUrl, writeSiteConfig, CLI_NAMES, type CliName } from "@relay/core";
import { log, RELAY_ROOT } from "./_common.ts";

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install session hooks and the relay MCP server into Claude Code, Codex and Grok Build configs (plan only without --yes)")
    .option("--yes", "write the planned files")
    .option("--only <cli>", "claude | codex | grok (installs even when the CLI is not detected)")
    .option("--remove", "remove relay's hooks and MCP entries instead")
    .option("--site <url>", "site mode: the hosted relay the CLI and hooks talk to instead of a local database (stored in ~/.harness/config.json)")
    .option("--token <token>", "bearer token for --site, minted at <site>/tokens (stored in ~/.harness/credentials.json, mode 0600)")
    .option("--no-site", "leave site mode: remove the site and its token; the CLI opens the local database again")
    .action(async (o: { yes?: boolean; only?: string; remove?: boolean; site?: string | boolean; token?: string }) => {
      if (o.only && !(CLI_NAMES as readonly string[]).includes(o.only)) throw new Error(`--only must be one of ${CLI_NAMES.join(", ")}`);
      // --- site mode ---
      if (o.site === false) {
        const paths = writeSiteConfig({ site: null, token: null });
        log(`site mode off: removed site from ${paths.configPath} and the token from ${paths.credentialsPath}`);
        return;
      }
      if (typeof o.site === "string" || o.token) {
        const current = readSiteConfig();
        const site = typeof o.site === "string" ? o.site : current.site;
        if (!site) throw new Error("--token needs --site <url> (or a site already configured)");
        const bad = validateSiteUrl(site);
        if (bad) throw new Error(bad);
        const token = o.token ?? current.token;
        if (!token) throw new Error(`--site needs --token <token>; mint one at ${site.replace(/\/+$/, "")}/tokens while signed in`);
        const probe = await httpClient({ site, token }).health();
        if (!probe.ok) {
          log(`check failed: ${probe.detail}`);
          if (!o.yes) throw new Error("site not saved; fix the URL or token, or re-run with --yes to save anyway");
        } else log(`check: ${probe.detail}`);
        const paths = writeSiteConfig({ site, token: o.token ?? null });
        if (o.token) log(`token saved to ${paths.credentialsPath} (mode 0600)`);
        log(`site mode on: ${site} (${paths.configPath}); memory, feed, token, task and webhook commands and the hooks now use the site. relay link still digests locally and uploads.`);
        return;
      }
      const siteCfg = readSiteConfig();
      if (siteCfg.site) console.log(`site mode: ${siteCfg.site}${siteCfg.token ? "" : " (no token; run relay setup --site <url> --token <t>)"}\n`);
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
