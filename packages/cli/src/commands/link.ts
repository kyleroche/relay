/**
 * `relay link`: the one per-repo step. It installs the owned sections in AGENTS.md/CLAUDE.md, registers the cwd repo
 * as a project and hashes its files, digests the files whose content changed (Sonnet lane, batches), writes the
 * project summary, renders relay.md from that summary, and installs the caller workflows and the lane labels.
 * Idempotent: a second run with nothing changed makes zero model calls. --refresh re-digests stale files and rewrites
 * the summary and the workflows; --no-digest skips the model steps; --force overwrites a locally edited owned section.
 * In site mode the last stage, `events`, asks the site whether its GitHub App is installed on the repo (otherwise the
 * repo's issues, labels, PRs and previews never arrive) and prints the install link; --no-events skips it.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestProject, emptyUsage, formatUsage, installOwnedSection, invalidateBriefCache, renderRulesFile, repo, registerProject, summarizeProject } from "@relay/core";
import { gitRemoteRepo, gitRoot, humanActor, log, onPath, openReady, RELAY_ROOT } from "./_common.ts";
import { eventsCheck, eventsLeft, formatStage, localEventsCheck } from "./events-check.ts";

const TEMPLATES = join(RELAY_ROOT, "packages", "cli", "templates");
const WORKFLOWS = ["relay-caller.yml", "relay-review.yml", "relay-cloud.yml"] as const;
const LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: "agent:claude", color: "D97757", description: "relay: implement with the Claude lane" },
  { name: "agent:codex", color: "10A37F", description: "relay: implement with the Codex lane" },
  { name: "agent:grok", color: "1DA1F2", description: "relay: implement with the Grok lane" },
  { name: "agent:claude-cloud", color: "F2C4B3", description: "relay: hand to Claude's cloud tier (@claude), no runner" },
  { name: "agent:codex-cloud", color: "9FE3CF", description: "relay: hand to Codex cloud (@codex), no runner" },
  { name: "agent:nodes", color: "E4A11B", description: "relay: run a Griptape Nodes workflow on a worker that has the engine" },
  { name: "deliverable:asset", color: "7057FF", description: "relay: the result is a media asset, not code" },
  // a production's stages (docs/ARCHITECTURE.md "A task's life", the asset path): which step of the film the issue is
  { name: "stage:script", color: "BFD4F2", description: "relay: production stage, the script" },
  { name: "stage:character", color: "BFD4F2", description: "relay: production stage, a character design" },
  { name: "stage:shot", color: "BFD4F2", description: "relay: production stage, a shot" },
  { name: "stage:vo", color: "BFD4F2", description: "relay: production stage, voice-over" },
  { name: "stage:cut", color: "BFD4F2", description: "relay: production stage, the cut" },
];

interface LinkOptions {
  repo?: string;
  project?: string;
  refresh?: boolean;
  force?: boolean;
  digest: boolean;
  maxFiles: string;
  labels: boolean;
  workflows: boolean;
  events: boolean;
  cwd?: string;
}

export function registerLink(program: Command): void {
  program
    .command("link")
    .description("Link this repo: register it, digest changed files, write the project summary and relay.md, install the owned sections and lane labels, check GitHub events reach the site")
    .option("--repo <owner/name>", "override the origin remote")
    .option("--project <slug>", "project slug (default: the repo name)")
    .option("--refresh", "re-digest stale files and rewrite the summary, relay.md (and the caller workflows with --workflows)")
    .option("--force", "overwrite a locally edited owned section")
    .option("--no-digest", "skip the model steps (file digests and the project summary)")
    .option("--max-files <n>", "max files to digest in this run", "400")
    .option("--no-labels", "skip gh label creation")
    .option("--workflows", "also install the GitHub Actions caller workflows (docs/RUNNERS.md): only for repos run by self-hosted runners; workers need none")
    .option("--no-events", "skip the check that GitHub events for this repo reach the site (the GitHub App installation)")
    .option("--cwd <path>")
    .action(async (o: LinkOptions) => {
      const cwd = o.cwd ?? process.cwd();
      const root = gitRoot(cwd);
      if (!root) throw new Error(`${cwd} is not inside a git repository`);
      const repoName = o.repo ?? gitRemoteRepo(root);
      if (!repoName) throw new Error("no origin remote; pass --repo owner/name");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repoName)) throw new Error(`--repo must be owner/name (got ${repoName})`);
      const slug = o.project ?? repoName.split("/")[1]!;
      const maxFiles = Math.max(0, Number(o.maxFiles) || 0);
      let failed = false;
      // the digest cache is always local: the Claude login that writes digests lives on this machine
      const h = await openReady({ local: true });
      try {
        // the cost line is read back from the ledger: every step.usage event newer than the project's latest one now
        const latest = (await repo.listEvents(h.db, { project: slug, limit: 1 }))[0]?.ts ?? "1970-01-01T00:00:00Z";

        // 1. owned sections first, so a freshly created AGENTS.md is hashed and digested in the same run
        for (const s of installOwnedSection(root, { project: slug, repo: repoName, ...(o.force ? { force: true } : {}) })) log(`sections: ${s.file} ${s.action}${s.detail ? ` (${s.detail})` : ""}`);

        // 2. register + hash
        const existed = !!(await repo.getProject(h.db, slug));
        const r = await registerProject(h, { slug, path: root });
        await repo.upsertProject(h.db, { slug, repo: repoName });
        log(`register: ${slug} (${repoName}) ${existed ? "refreshed" : "registered"}, ${r.files} files hashed${r.removed ? `, ${r.removed} removed` : ""}`);

        // 3. digests, 4. summary
        if (o.digest) {
          const stale = (await repo.listFileDigests(h.db, slug, { staleOnly: true })).length;
          let digested = 0;
          if (!stale) log("digest: every file is current");
          else {
            log(`digest: ${Math.min(stale, maxFiles)} of ${stale} stale files, Sonnet lane in batches…`);
            const d = await digestProject(h, slug, { maxFiles, log });
            digested = d.digested;
            const left = stale - Math.min(stale, maxFiles);
            log(`digest: ${d.digested} files digested in ${d.calls} calls${d.retried ? `, ${d.retried} re-requested` : ""}${d.failed.length ? `, ${d.failed.length} failed` : ""}${left ? `; ${left} left for the next run (--max-files)` : ""}`);
          }
          const project = await repo.getProject(h.db, slug);
          if (!o.refresh && project?.summary && !digested) log("summary: current");
          else {
            log(`summary: ${project?.summary ? "rewriting" : "writing"} the project brief…`);
            try {
              const s = await summarizeProject(h, slug, log);
              log(`summary: ${s.tokens} tokens in ${s.calls} call${s.calls === 1 ? "" : "s"}`);
            } catch (e) {
              failed = true;
              log(`summary: FAILED. ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } else log("digest, summary: skipped (--no-digest)");

        // 5. relay.md from the real summary; rewritten whenever its content changed
        const project = await repo.getProject(h.db, slug);
        const rulesPath = join(root, "relay.md");
        const rules = await renderRulesFile(h.db, slug, { repo: repoName });
        const prev = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : undefined;
        const noSummary = project?.summary ? "" : "; no project summary yet, run relay link --refresh once claude is logged in";
        if (prev === rules.text) log(`relay.md: unchanged (${rules.tokens} tokens${noSummary})`);
        else {
          writeFileSync(rulesPath, rules.text);
          log(`relay.md: ${prev === undefined ? "written" : "updated"} (${rules.tokens} tokens${noSummary})`);
        }

        // 6. caller workflows: opt-in. The worker path needs none; a committed caller would queue an Actions run on every
        // label that waits for a self-hosted runner that may not exist.
        if (o.workflows) {
          const relayRepo = h.cfg.relayRepo ?? `${repoName.split("/")[0]}/relay`;
          const relayRef = h.cfg.relayRef ?? "main";
          const dir = join(root, ".github", "workflows");
          mkdirSync(dir, { recursive: true });
          for (const w of WORKFLOWS) {
            const dest = join(dir, w);
            const content = readFileSync(join(TEMPLATES, w), "utf8").replaceAll("__RELAY_REPO__", relayRepo).replaceAll("__RELAY_REF__", relayRef);
            if (existsSync(dest) && !o.refresh) {
              log(`workflows: ${w} exists (--refresh rewrites it)`);
              continue;
            }
            const same = existsSync(dest) && readFileSync(dest, "utf8") === content;
            if (!same) writeFileSync(dest, content);
            log(`workflows: ${w} ${same ? "unchanged" : "written"} (uses ${relayRepo}@${relayRef})`);
          }
        }

        // 7. lane labels
        if (o.labels) {
          const gh = onPath("gh");
          if (!gh) log("labels: gh not on PATH; create agent:claude|codex|grok, agent:claude-cloud|codex-cloud and deliverable:asset by hand");
          else
            for (const l of LABELS) {
              try {
                execFileSync(gh, ["label", "create", l.name, "--repo", repoName, "--color", l.color, "--description", l.description, "--force"], { stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 });
                log(`labels: ${l.name} ok`);
              } catch (e) {
                log(`labels: ${l.name} failed (${(e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 100)})`);
              }
            }
        }

        invalidateBriefCache(slug);
        const usage = emptyUsage();
        const usageRows = await repo.listEvents(h.db, { project: slug, kind: "step.usage", after: latest, limit: 5000 });
        for (const e of usageRows) {
          usage.calls++;
          usage.tokensIn += e.tokens_in + e.cache_read + e.cache_write;
          usage.tokensOut += e.tokens_out;
          usage.costEquiv += e.cost_equiv;
        }
        await repo.writeEvent(h.db, { kind: "project.linked", actor: humanActor(), project: slug, repo: repoName, summary: `${repoName} linked at ${root}`, payload: { path: root, refresh: !!o.refresh, digest: o.digest, calls: usage.calls } });

        // 8. site mode: the project, its digests and the summary go up through the API; the login never does
        if (h.mode === "site") {
          const site = h.client;
          const uploads = usageRows.map((e) => ({ lane: e.lane ?? "digest", model: e.model, subscription: e.subscription, tokens_in: e.tokens_in, tokens_out: e.tokens_out, cache_read: e.cache_read, cache_write: e.cache_write, cost_equiv: e.cost_equiv, duration_ms: e.duration_ms, summary: e.summary, ts: e.ts }));
          await site.registerProject({ slug, repo: repoName, path: root, ...(project?.stack ? { stack: project.stack } : {}), ...(project?.check_cmd ? { checkCmd: project.check_cmd } : {}) });
          const digests = await repo.listFileDigests(h.db, slug);
          const up = await site.putDigests(slug, digests.map((d) => ({ path: d.path, sha256: d.sha256, size: d.size, summary: d.summary, summary_sha: d.summary_sha, tokens: d.tokens })), { prune: true, usage: uploads });
          if (project?.summary) await site.putSummary(slug, project.summary, project.summary_tokens ?? 0);
          log(`site: ${site.site} has ${slug} with ${up.files} file digests${project?.summary ? " and the summary" : ""}${uploads.length ? `, ${uploads.length} usage rows` : ""}`);
        }

        // 9. events: do GitHub's deliveries for this repo reach the store? Advice only; never fails the link. After the
        // site upload, so a first link finds its project on the site.
        let left: string | undefined;
        if (o.events) {
          if (h.mode !== "site") log(formatStage(localEventsCheck()));
          else {
            const site = h.client.site!;
            try {
              const status = await h.client.githubStatus(slug);
              if (!status) log(formatStage({ status: "warn", name: "events", detail: `${site} does not know project ${slug} yet; re-run relay link` }));
              else {
                log(formatStage(eventsCheck(status, site)));
                left = eventsLeft(status, site);
              }
            } catch (e) {
              log(formatStage({ status: "warn", name: "events", detail: `could not check GitHub events on ${site}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` }));
            }
          }
        }
        log(`cost: ${formatUsage(usage)}`);
        if (left) log(`left: ${left}`);
        if (failed) process.exitCode = 1;
      } finally {
        await h.close();
      }
    });
}
