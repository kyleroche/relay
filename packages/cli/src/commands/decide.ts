/** `relay decide <text>`: add a decision as source=human (or supersede one), write the feed event, drop the brief cache. */
import type { Command } from "commander";
import { invalidateBriefCache, repo } from "@relay/core";
import { humanActor, log, openReady, resolveProject } from "./_common.ts";

export function registerDecide(program: Command): void {
  program
    .command("decide")
    .argument("<text...>", 'one sentence: "we do X because Y"')
    .option("--project <slug>", "project slug (default: the linked project of the cwd); use --global for a global decision")
    .option("--global", "a decision that applies to every project")
    .option("--source <name>", "claude | codex | grok | pr | human | nightly", "human")
    .option("--ref <source_ref>", "session id, PR url, or similar")
    .option("--supersedes <id>", "close this decision's validity and link the replacement")
    .option("--cwd <path>")
    .description("Record a durable decision in shared memory")
    .action(async (words: string[], o: { project?: string; global?: boolean; source: string; ref?: string; supersedes?: string; cwd?: string }) => {
      const text = words.join(" ").trim();
      if (text.length < 8) throw new Error("a decision needs a sentence");
      const h = await openReady();
      try {
        let project: string | null = null;
        if (!o.global) {
          const r = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
          if (!r.slug) throw new Error("no project: pass --project, run relay link, or use --global");
          if (!(await repo.getProject(h.db, r.slug))) throw new Error(`unknown project ${r.slug}; run relay link first`);
          project = r.slug;
        }
        const actor = humanActor();
        const row = o.supersedes
          ? await repo.supersedeDecision(h.db, Number(o.supersedes), { text, source: o.source, ...(o.ref ? { sourceRef: o.ref } : {}) })
          : await repo.addDecision(h.db, { project, text, source: o.source, ...(o.ref ? { sourceRef: o.ref } : {}) });
        await repo.writeEvent(h.db, { kind: "decision.captured", actor, project, summary: text.slice(0, 200), payload: { decision_id: row.id, source: o.source, source_ref: o.ref ?? null, superseded: o.supersedes ? Number(o.supersedes) : null } });
        invalidateBriefCache(project ?? undefined);
        log(`decision #${row.id} recorded${project ? ` for ${project}` : " (global)"}${o.supersedes ? `, supersedes #${o.supersedes}` : ""}`);
        console.log(JSON.stringify(row));
      } finally {
        await h.close();
      }
    });
}
