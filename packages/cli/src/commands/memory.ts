/** `relay memory history`: decisions including superseded ones, with their validity windows. */
import type { Command } from "commander";
import { openReady, resolveProject } from "./_common.ts";

export function registerMemory(program: Command): void {
  const memory = program.command("memory").description("Inspect shared memory");
  memory
    .command("history")
    .option("--project <slug>", "project slug (default: the linked project of the cwd)")
    .option("--global", "global decisions only")
    .option("--current", "current decisions only")
    .option("--limit <n>", "rows", "200")
    .option("--cwd <path>")
    .option("--json")
    .description("Decisions for a project including superseded ones, newest first")
    .action(async (o: { project?: string; global?: boolean; current?: boolean; limit: string; cwd?: string; json?: boolean }) => {
      let project: string | null | undefined;
      if (o.global) project = null;
      else {
        const r = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
        project = r.slug;
        if (!project) throw new Error("no project: pass --project, run relay link, or use --global");
      }
      const h = await openReady();
      try {
        const rows = await h.client.listDecisions(project, { limit: Number(o.limit), ...(o.current ? { current: true } : {}) });
        if (o.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        for (const d of rows) {
          const window = d.valid_to ? `${d.valid_from.slice(0, 10)} → ${d.valid_to.slice(0, 10)}${d.superseded_by ? ` (superseded by #${d.superseded_by})` : ""}` : `${d.valid_from.slice(0, 10)} → current`;
          console.log(`#${String(d.id).padEnd(5)} ${window.padEnd(44)} ${(d.source ?? "-").padEnd(7)} ${d.text}`);
        }
        if (!rows.length) console.error(`[relay] no decisions${project ? ` for ${project}` : ""}`);
      } finally {
        await h.close();
      }
    });
}
