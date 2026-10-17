/**
 * `relay lane`: what the lane adapters hand the vendor CLIs, for scripts that start a CLI themselves.
 *
 *   relay lane settings [--allow a.example,b.example]   the Claude Code `--settings` JSON that sandboxes a code run
 *
 * `scripts/runner/run-lane.sh` calls `relay lane settings` so the Actions path and `relay work` share one sandbox
 * definition (`packages/core/src/lanes/sandbox.ts`). `RELAY_LANE_ALLOWED_DOMAINS` adds hosts the same way it does for
 * the worker.
 */
import type { Command } from "commander";
import { claudeSandboxSettings, parseDomainList } from "@relay/core";

export function registerLane(program: Command): void {
  const lane = program.command("lane").description("What the lane adapters pass to the vendor CLIs (for scripts that start a CLI themselves)");
  lane
    .command("settings")
    .description("Print the Claude Code --settings JSON that puts a code run's Bash in the OS sandbox (one line; --pretty indents)")
    .option("--allow <domains>", "extra hosts for the network allowlist, comma-separated (added to RELAY_LANE_ALLOWED_DOMAINS)")
    .option("--pretty", "indent the JSON")
    .action((o: { allow?: string; pretty?: boolean }) => {
      const allowedDomains = [...parseDomainList(process.env.RELAY_LANE_ALLOWED_DOMAINS), ...parseDomainList(o.allow)];
      const settings = claudeSandboxSettings(allowedDomains.length ? { allowedDomains } : {});
      console.log(o.pretty ? JSON.stringify(settings, null, 2) : JSON.stringify(settings));
    });
}
