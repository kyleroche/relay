/** `relay prefer <key> <value> --scope <scope>`: set a preference, write the feed event, drop the brief cache. */
import type { Command } from "commander";
import { invalidateBriefCache, repo } from "@relay/core";

type PreferenceRow = repo.PreferenceRow;
import { humanActor, log, openReady, resolveProject } from "./_common.ts";

const SCOPES: ReadonlyArray<PreferenceRow["scope"]> = ["global", "project", "lane", "model"];

export function registerPrefer(program: Command): void {
  program
    .command("prefer")
    .argument("<key>")
    .argument("<value...>")
    .requiredOption("--scope <scope>", "global | project | lane | model")
    .option("--id <scope_id>", "project slug, lane name, or model id (project scope defaults to the linked project of the cwd)")
    .option("--reason <text>")
    .option("--cwd <path>")
    .description("Set a preference at a scope; narrower scopes override wider ones in briefs")
    .action(async (key: string, valueWords: string[], o: { scope: string; id?: string; reason?: string; cwd?: string }) => {
      if (!SCOPES.includes(o.scope as PreferenceRow["scope"])) throw new Error(`--scope must be one of ${SCOPES.join(", ")}`);
      const scope = o.scope as PreferenceRow["scope"];
      const value = valueWords.join(" ");
      let scopeId: string | null = o.id ?? null;
      if (scope === "project" && !scopeId) {
        const r = resolveProject(o.cwd ? { cwd: o.cwd } : {});
        if (!r.slug) throw new Error("project scope needs --id <slug> or a linked cwd");
        scopeId = r.slug;
      }
      if (scope !== "global" && !scopeId) throw new Error(`scope ${scope} needs --id`);
      if (scope === "global") scopeId = null;
      const h = await openReady();
      try {
        await repo.upsertPreference(h.db, { key, value, scope, scope_id: scopeId, reason: o.reason ?? null });
        await repo.writeEvent(h.db, { kind: "preference.set", actor: humanActor(), project: scope === "project" ? scopeId : null, summary: `${key} = ${value} (${scope}${scopeId ? `: ${scopeId}` : ""})`, payload: { key, value, scope, scope_id: scopeId, reason: o.reason ?? null } });
        invalidateBriefCache(scope === "project" ? scopeId! : undefined);
        log(`${key} = ${value} at ${scope}${scopeId ? ` ${scopeId}` : ""}`);
      } finally {
        await h.close();
      }
    });
}
