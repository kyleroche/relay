/**
 * `relay recall [text]`: current decisions and merged preferences for a project, matched to the text when given.
 * In --hook mode (UserPromptSubmit) output is capped at 1K tokens and nothing is printed unless the cwd is linked.
 */
import type { Command } from "commander";
import { approxTokens } from "@relay/core";
import { hookSafe, log, openReady, resolveProject } from "./_common.ts";

/** Fit whole lines under a token budget. */
function fitLines(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const t = approxTokens(l + "\n");
    if (used + t > budget) break;
    out.push(l);
    used += t;
  }
  return out;
}

export function registerRecall(program: Command): void {
  program
    .command("recall")
    .argument("[text...]", "what you are about to do (omitted: everything current for the project)")
    .option("--project <slug>")
    .option("--cwd <path>")
    .option("--lane <name>", "merge lane-scoped preferences")
    .option("--max-tokens <n>", "cap on the output", "1000")
    .option("--hook", "hook mode: silent unless the cwd is linked, never fails")
    .option("--json")
    .description("Decisions and preferences relevant to a text (what a brief would contain right now)")
    .action(async (words: string[], o: { project?: string; cwd?: string; lane?: string; maxTokens: string; hook?: boolean; json?: boolean }) => {
      const hook = !!o.hook;
      await hookSafe(hook, async () => {
        const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
        if (hook && !ref.linked && !o.project) return;
        if (!ref.slug) throw new Error("no project: pass --project or run relay link in the repo");
        const query = words.join(" ").trim();
        const budget = Number(o.maxTokens);
        const h = await openReady();
        try {
          if (!(await h.client.getProject(ref.slug))) {
            if (hook) return;
            throw new Error(`unknown project ${ref.slug}; run relay link first`);
          }
          const r = await h.client.recall({ project: ref.slug, query, ...(o.lane ? { lane: o.lane } : {}) });
          if (o.json) {
            console.log(JSON.stringify({ project: ref.slug, preferences: r.preferences, decisions: r.decisions, text: r.text }, null, 2));
            return;
          }
          const lines = r.text ? r.text.split("\n") : [];
          if (!lines.length) {
            if (!hook) log(`no decisions or preferences for ${ref.slug}`);
            return;
          }
          const out = fitLines(lines, budget);
          process.stdout.write((hook ? `relay memory for ${ref.slug}:\n` : "") + out.join("\n") + "\n");
          if (!hook && out.length < lines.length) log(`${lines.length - out.length} line(s) over the ${budget}-token cap`);
        } finally {
          await h.close();
        }
      });
    });
}
