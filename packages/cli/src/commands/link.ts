/**
 * `relay link`: register the cwd repo as a project, write relay.md and the owned sections, install the caller
 * workflows, and create the lane labels. Re-runnable; --refresh re-renders relay.md and the workflows, --force
 * overwrites a locally edited owned section.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installOwnedSection, invalidateBriefCache, renderRulesFile, repo, registerProject } from "@relay/core";
import { gitRemoteRepo, gitRoot, humanActor, log, onPath, openReady, RELAY_ROOT } from "./_common.ts";

const TEMPLATES = join(RELAY_ROOT, "packages", "cli", "templates");
const WORKFLOWS = ["relay-caller.yml", "relay-review.yml"] as const;
const LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: "agent:claude", color: "D97757", description: "relay: implement with the Claude lane" },
  { name: "agent:codex", color: "10A37F", description: "relay: implement with the Codex lane" },
  { name: "agent:grok", color: "1DA1F2", description: "relay: implement with the Grok lane" },
  { name: "deliverable:asset", color: "7057FF", description: "relay: the result is a media asset, not code" },
];

export function registerLink(program: Command): void {
  program
    .command("link")
    .description("Register this repo as a project: relay.md, owned sections in AGENTS.md/CLAUDE.md, caller workflows, lane labels")
    .option("--repo <owner/name>", "override the origin remote")
    .option("--project <slug>", "project slug (default: the repo name)")
    .option("--refresh", "re-render relay.md and rewrite the caller workflows")
    .option("--force", "overwrite a locally edited owned section")
    .option("--no-labels", "skip gh label creation")
    .option("--no-workflows", "skip the caller workflows")
    .option("--cwd <path>")
    .action(async (o: { repo?: string; project?: string; refresh?: boolean; force?: boolean; labels: boolean; workflows: boolean; cwd?: string }) => {
      const cwd = o.cwd ?? process.cwd();
      const root = gitRoot(cwd);
      if (!root) throw new Error(`${cwd} is not inside a git repository`);
      const repoName = o.repo ?? gitRemoteRepo(root);
      if (!repoName) throw new Error("no origin remote; pass --repo owner/name");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repoName)) throw new Error(`--repo must be owner/name (got ${repoName})`);
      const slug = o.project ?? repoName.split("/")[1]!;
      const h = await openReady();
      try {
        const existed = !!(await repo.getProject(h.db, slug));
        const r = await registerProject(h, { slug, path: root }, log);
        await repo.upsertProject(h.db, { slug, repo: repoName });
        log(`project ${slug} (${repoName}) ${existed ? "refreshed" : "registered"}: ${r.files} files hashed`);

        // relay.md: regenerate when missing or on --refresh
        const rulesPath = join(root, "relay.md");
        if (!existsSync(rulesPath) || o.refresh) {
          const rules = await renderRulesFile(h.db, slug, { repo: repoName });
          writeFileSync(rulesPath, rules.text);
          log(`wrote relay.md (${rules.tokens} tokens)`);
        } else log("relay.md exists; --refresh re-renders it");

        for (const s of installOwnedSection(root, { project: slug, repo: repoName, ...(o.force ? { force: true } : {}) })) log(`${s.file}: ${s.action}${s.detail ? ` (${s.detail})` : ""}`);

        if (o.workflows) {
          const relayRepo = h.cfg.relayRepo ?? `${repoName.split("/")[0]}/relay`;
          const relayRef = h.cfg.relayRef ?? "main";
          const dir = join(root, ".github", "workflows");
          mkdirSync(dir, { recursive: true });
          for (const w of WORKFLOWS) {
            const dest = join(dir, w);
            const content = readFileSync(join(TEMPLATES, w), "utf8").replaceAll("__RELAY_REPO__", relayRepo).replaceAll("__RELAY_REF__", relayRef);
            if (existsSync(dest) && !o.refresh) {
              log(`${w}: exists (--refresh rewrites it)`);
              continue;
            }
            const same = existsSync(dest) && readFileSync(dest, "utf8") === content;
            if (!same) writeFileSync(dest, content);
            log(`${w}: ${same ? "unchanged" : "written"} (uses ${relayRepo}@${relayRef})`);
          }
        }

        if (o.labels) {
          const gh = onPath("gh");
          if (!gh) log("gh not on PATH; create labels agent:claude|codex|grok and deliverable:asset by hand");
          else
            for (const l of LABELS) {
              try {
                execFileSync(gh, ["label", "create", l.name, "--repo", repoName, "--color", l.color, "--description", l.description, "--force"], { stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 });
                log(`label ${l.name}: ok`);
              } catch (e) {
                log(`label ${l.name}: failed (${(e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 100)})`);
              }
            }
        }

        invalidateBriefCache(slug);
        await repo.writeEvent(h.db, { kind: "project.linked", actor: humanActor(), project: slug, repo: repoName, summary: `${repoName} linked at ${root}`, payload: { path: root, refresh: !!o.refresh } });
      } finally {
        await h.close();
      }
    });
}
