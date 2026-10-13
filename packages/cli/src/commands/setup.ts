/** `relay setup`: install hooks and the memory MCP server into each detected CLI. Plans first, writes with --yes. */
import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, defaultHookContext, planSetup, CLI_NAMES, type CliName } from "@relay/core";
import { log, RELAY_ROOT } from "./_common.ts";

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install session hooks and the relay MCP server into Claude Code, Codex and Grok Build configs (plan only without --yes)")
    .option("--yes", "write the planned files")
    .option("--only <cli>", "claude | codex | grok (installs even when the CLI is not detected)")
    .option("--remove", "remove relay's hooks and MCP entries instead")
    .action((o: { yes?: boolean; only?: string; remove?: boolean }) => {
      if (o.only && !(CLI_NAMES as readonly string[]).includes(o.only)) throw new Error(`--only must be one of ${CLI_NAMES.join(", ")}`);
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
