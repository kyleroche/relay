/**
 * `relay lane`: what the lane adapters hand the vendor CLIs, for scripts that start a CLI themselves, and a manual run
 * of the nodes lane.
 *
 *   relay lane settings [--allow a.example,b.example]   the Claude Code `--settings` JSON that sandboxes a code run
 *   relay lane nodes --workflow <file> --inputs '<json>' [--out <dir>] [--outputs "End Flow"] [--model <id>]
 *                                                        run one Griptape Nodes workflow headless through the adapter
 *
 * `scripts/runner/run-lane.sh` calls `relay lane settings` so the Actions path and `relay work` share one sandbox
 * definition (`packages/core/src/lanes/sandbox.ts`). `RELAY_LANE_ALLOWED_DOMAINS` adds hosts the same way it does for
 * the worker. `relay lane nodes` is the worker's nodes stage without the task: the same shim, the same usage rows
 * (written to this machine's ledger in local mode), the files left in --out for the operator.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { claudeSandboxSettings, DEFAULT_NODES_TIMEOUT_MS, findNodesPython, parseDomainList, recordNodesUsage, runNodes, runtimePaths } from "@relay/core";
import { humanActor, log, openReady } from "./_common.ts";

export function registerLane(program: Command): void {
  const lane = program.command("lane").description("What the lane adapters pass to the vendor CLIs (for scripts that start a CLI themselves), and a manual nodes run");
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

  lane
    .command("nodes")
    .description("Run one Griptape Nodes workflow headless through the nodes lane adapter: outputs land in --out, usage in this machine's ledger (local mode)")
    .requiredOption("--workflow <file>", "the workflow .py file")
    .option("--inputs <json>", "flow input as JSON: { \"<start node>\": { \"<parameter>\": value } }, or @<file>", "{}")
    .option("--out <dir>", "where the output files go", ".relay-nodes-out")
    .option("--outputs <nodes>", "comma-separated end nodes to keep (default: every end node; text outputs only for listed nodes)")
    .option("--model <id>", "model id for the usage rows when the node types are not in relay's table, e.g. bytedance/seedance-2.0")
    .option("--max-minutes <n>", "time limit", String(DEFAULT_NODES_TIMEOUT_MS / 60_000))
    .option("--no-record", "do not write the usage rows to the ledger")
    .option("--json", "print the adapter's result as JSON")
    .action(async (o: { workflow: string; inputs: string; out: string; outputs?: string; model?: string; maxMinutes: string; record: boolean; json?: boolean }) => {
      const workflow = resolve(o.workflow);
      if (!existsSync(workflow)) throw new Error(`workflow file not found: ${workflow}`);
      const raw = o.inputs.startsWith("@") ? readFileSync(o.inputs.slice(1), "utf8") : o.inputs;
      let inputs: Record<string, Record<string, unknown>>;
      try {
        inputs = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      } catch (e) {
        throw new Error(`--inputs is not JSON: ${(e as Error).message}`);
      }
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("--inputs must be a JSON object: { node: { parameter: value } }");
      const python = findNodesPython();
      log(`engine: ${python ? python.join(" ") : "not found"}; shim: ${runtimePaths().runWorkflowScript}`);
      const r = await runNodes({
        workflow,
        inputs,
        ...(o.outputs ? { outputs: o.outputs.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        outDir: resolve(o.out),
        timeoutMs: Math.max(1, Number(o.maxMinutes) || 60) * 60_000,
        ...(o.model ? { model: o.model } : {}),
      });
      if (o.record && r.usage.length) {
        const h = await openReady();
        try {
          if (h.mode === "local") {
            const rows = await recordNodesUsage(h.db, r.usage, { actor: humanActor(), engineVersion: r.engineVersion, workflow: o.workflow });
            log(`ledger: ${rows.length} step.usage row${rows.length === 1 ? "" : "s"} written`);
          } else log("site mode: usage rows are not written from here (a worker reports them through release)");
        } finally {
          await h.close();
        }
      }
      if (o.json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        for (const out of r.outputs) log(`output: ${out.node}.${out.parameter} -> ${out.path} (${out.mime}, ${out.bytes} B)`);
        for (const u of r.usage) log(`usage: ${u.lane} ${u.model ?? "unknown model"} x${u.outputs}${u.costKnown ? ` $${u.costEquiv.toFixed(4)}` : " (cost unknown)"}`);
        log(`${r.ok ? "ok" : `failed: ${r.error}`}; Griptape Nodes ${r.engineVersion}, ${Math.round(r.durationMs / 1000)}s, ${r.outputs.length} output${r.outputs.length === 1 ? "" : "s"} in ${resolve(o.out)}`);
        if (!r.ok && r.raw?.stderr) console.error(r.raw.stderr.slice(-2000));
      }
      if (!r.ok) process.exitCode = 1;
    });
}
