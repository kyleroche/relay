/**
 * `relay brief <issue-or-intent>`: the compiled memory envelope for a project. A number is a GitHub issue (fetched
 * through gh when present); anything else is the intent text. In --hook mode the result is cached per project for
 * ten minutes under ~/.harness/cache/brief/ and nothing is printed when the cwd is not a linked repo.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { briefEmbedder, compileBrief, readCachedBrief, writeCachedBrief, repo, type BriefIssue } from "@relay/core";
import { hookSafe, log, onPath, openReady, resolveProject } from "./_common.ts";

export const SESSION_START_INTENT = "session start";
export const SESSION_START_TOKENS = 2500;

/** The cache key the hook scripts compute too (packages/cli/hooks/_lib.mjs); keep both in sync. */
export const briefCacheKey = (intent: string, maxTokens: number, model?: string, lane?: string): string => `${intent}|${maxTokens}|${model ?? ""}|${lane ?? ""}`;

function fetchIssue(repoName: string | undefined, n: number): BriefIssue {
  const gh = onPath("gh");
  if (gh && repoName) {
    try {
      const out = execFileSync(gh, ["issue", "view", String(n), "--repo", repoName, "--json", "title,body"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
      const j = JSON.parse(out) as { title?: string; body?: string };
      return { number: n, title: j.title ?? `issue #${n}`, body: (j.body ?? "").slice(0, 6000) };
    } catch {
      /* fall back */
    }
  }
  return { number: n, title: `issue #${n}` };
}

export function registerBrief(program: Command): void {
  program
    .command("brief")
    .argument("[issue-or-intent...]", "an issue number, or free text describing what is about to happen")
    .option("--project <slug>", "project slug (default: the linked project of the cwd, else the repo name)")
    .option("--cwd <path>")
    .option("--max-tokens <n>", "hard cap on the envelope", "3000")
    .option("--model <id>", "include vendor guidance for this model")
    .option("--lane <name>", "merge lane-scoped preferences (claude | codex | grok)")
    .option("--hook", "hook mode: cached 10 min, silent when the cwd is not linked, never fails")
    .option("--no-cache", "ignore and do not write the cache")
    .option("--json", "print {text, sections, tokens, omitted}")
    .description("Compile the memory brief for an issue or intent: summary, preferences, decisions, guidance under a token cap")
    .action(async (words: string[], o: { project?: string; cwd?: string; maxTokens: string; model?: string; lane?: string; hook?: boolean; cache: boolean; json?: boolean }) => {
      const hook = !!o.hook;
      await hookSafe(hook, async () => {
        const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
        if (hook && !ref.linked && !o.project) return;
        if (!ref.slug) throw new Error("no project: pass --project or run relay link in the repo");
        const maxTokens = Number(o.maxTokens);
        const text = words.join(" ").trim();
        const issueNo = /^#?\d+$/.test(text) ? Number(text.replace("#", "")) : undefined;
        const intent = issueNo ? `implement issue #${issueNo}` : text || SESSION_START_INTENT;
        const key = briefCacheKey(issueNo ? `issue:${issueNo}` : intent, maxTokens, o.model, o.lane);
        if (o.cache && !issueNo) {
          const hit = readCachedBrief(ref.slug, key);
          if (hit) {
            process.stdout.write(o.json ? JSON.stringify({ text: hit.text, tokens: hit.tokens, cached: true }) + "\n" : hit.text);
            return;
          }
        }
        const h = await openReady();
        try {
          if (!(await repo.getProject(h.db, ref.slug))) {
            if (hook) return;
            throw new Error(`unknown project ${ref.slug}; run relay link first`);
          }
          const embed = briefEmbedder(h);
          const issue = issueNo ? fetchIssue(ref.repo, issueNo) : undefined;
          const b = await compileBrief(h.db, { project: ref.slug, intent, maxTokens, ...(issue ? { issue } : {}), ...(o.model ? { model: o.model } : {}), ...(o.lane ? { lane: o.lane } : {}), ...(embed ? { embed } : {}) });
          if (o.cache && !issueNo) writeCachedBrief({ project: ref.slug, key, text: b.text, tokens: b.tokens });
          if (o.json) console.log(JSON.stringify({ text: b.text, sections: b.sections, tokens: b.tokens, omitted: b.omitted }, null, 2));
          else {
            process.stdout.write(b.text);
            if (!hook) log(`${b.tokens} tokens: ${b.sections.map((s) => `${s.name}=${s.tokens}`).join(" ")}${b.omitted.length ? ` (omitted: ${b.omitted.join(", ")})` : ""}`);
          }
        } finally {
          await h.close();
        }
      });
    });
}
