/**
 * `relay project …`: register projects and maintain their file digests. `relay link` runs the whole pipeline for a
 * repository checkout; `relay project add <slug> --repo owner/name` registers a project that has no checkout at all,
 * such as a production (one GitHub repo used only for issues, one relay project per production, docs/ARCHITECTURE.md
 * "A task's life"): it goes through `RelayClient.registerProject` (`PUT /api/v1/projects/{slug}` on a site, the local
 * database otherwise), so it works in either mode, and it is idempotent. The digest commands need the database on
 * this machine and stay local.
 */
import type { Command } from "commander";
import { resolve } from "node:path";
import { digestProject, openHarness, registerProject, repo, summarizeProject } from "@relay/core";
import { log, openReady, whereNote } from "./_common.ts";

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Register projects and maintain their file digests");
  project
    .command("add")
    .argument("<slug>")
    .argument("[path]", "a checkout to hash; omit it for a project with no checkout (then --repo is required)")
    .option("--repo <owner/name>", "the GitHub repository the project's issues live in (several projects may share one)")
    .option("--stack <text>", "one-line stack note")
    .option("--check <cmd>", "check command (build/test/lint) the task loop runs after each step")
    .description("Register (or refresh) a project: with a path, hash its files; with --repo alone, a project that has no checkout, such as a production")
    .action(async (slug: string, path: string | undefined, o: { repo?: string; stack?: string; check?: string }) => {
      if (!/^[\w.-]{1,100}$/.test(slug)) throw new Error("slug must be letters, digits, dots, dashes or underscores");
      if (o.repo && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("--repo must be owner/name");
      if (!path) {
        if (!o.repo) throw new Error("pass a checkout path, or --repo owner/name for a project without one");
        const h = await openReady();
        try {
          const existed = !!(await h.client.getProject(slug));
          await h.client.registerProject({ slug, repo: o.repo, ...(o.stack ? { stack: o.stack } : {}), ...(o.check ? { checkCmd: o.check } : {}) });
          console.log(`${existed ? "refreshed" : "registered"} ${slug} -> ${o.repo} (${whereNote(h)}); open tasks with relay task create --project ${slug}`);
        } finally {
          await h.close();
        }
        return;
      }
      const h = await openHarness();
      try {
        const args: { slug: string; path: string; repo?: string; stack?: string; checkCmd?: string } = { slug, path: resolve(path) };
        if (o.repo) args.repo = o.repo;
        if (o.stack) args.stack = o.stack;
        if (o.check) args.checkCmd = o.check;
        console.log(JSON.stringify(await registerProject(h, args, log)));
      } finally {
        await h.close();
      }
    });
  project
    .command("digest")
    .argument("<slug>")
    .option("--max <n>", "max files this run", "400")
    .option("--batch <n>", "files per Sonnet call", "8")
    .description("Summarize files whose content hash changed since their last digest (Sonnet, no tools)")
    .action(async (slug: string, o: { max: string; batch: string }) => {
      const h = await openHarness();
      try {
        console.log(JSON.stringify(await digestProject(h, slug, { maxFiles: Number(o.max), batchFiles: Number(o.batch), log })));
      } finally {
        await h.close();
      }
    });
  project
    .command("summarize")
    .argument("<slug>")
    .description("Write the ≤500-word project summary from README/AGENTS files and the digest index (relay link does this for you)")
    .action(async (slug: string) => {
      const h = await openHarness();
      try {
        console.log((await summarizeProject(h, slug, log)).text);
      } finally {
        await h.close();
      }
    });
  project
    .command("show")
    .argument("<slug>")
    .description("Project row, digest coverage, and summary")
    .action(async (slug: string) => {
      const h = await openHarness();
      try {
        const p = await repo.getProject(h.db, slug);
        if (!p) throw new Error(`unknown project ${slug}`);
        const files = await repo.listFileDigests(h.db, slug);
        const stale = files.filter((f) => !f.summary || f.summary_sha !== f.sha256).length;
        console.log(`${p.slug}  ${p.repo ?? "-"}  ${p.path ?? "-"}\nstack: ${p.stack ?? "-"}  check: ${p.check_cmd ?? "-"}\nfiles: ${files.length} (${stale} need digest)  summary: ${p.summary_tokens ?? 0} tokens`);
        for (const f of files.slice(0, 15)) console.log(`  ${f.path.padEnd(48)} ${f.summary ? f.summary.slice(0, 90) : "(no digest)"}`);
        if (p.summary) console.log("\n" + p.summary);
      } finally {
        await h.close();
      }
    });
  project
    .command("list")
    .description("Every project: slug, repository, checkout path, summary size (from the site in site mode)")
    .action(async () => {
      const h = await openReady();
      try {
        for (const p of await h.client.listProjects()) console.log(`${p.slug.padEnd(20)} ${(p.repo ?? "-").padEnd(28)} ${p.path ?? "-"}  summary=${p.summary_tokens ?? 0}tok`);
      } finally {
        await h.close();
      }
    });
}
