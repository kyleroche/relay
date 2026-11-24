/**
 * `relay link`: the one command that adds a repository to relay. Run inside the repository, it
 *
 *   registers the project and hashes its files, digests the files whose content changed (Sonnet lane, batches) and
 *   writes the project summary, all in relay's memory;
 *   adopts what Claude Code knows about the repository on this machine (`planAdoption`): standing preferences become
 *   decisions in memory, project notes become files under docs/context, the commands that were run become a first
 *   `.relay/project.json` when the repository has none;
 *   and proposes every file it would change in the repository as ONE pull request against the default branch: the
 *   owned sections of AGENTS.md and CLAUDE.md, `.relay/rules.json`, `relay.md`, the adopted notes and profile, and the
 *   removal of the caller workflows the earlier GitHub Actions path installed.
 *
 * The checkout is not touched: the files are read from origin's default branch and the commit is made beside it
 * (`_tree.ts`). Nothing reaches the default branch, where workers read the profile and the steps, until a person
 * merges the pull request. A repository with no origin, a machine without gh, or `--no-pr` gets the same files
 * written into the working tree instead.
 *
 * While that pull request is open, a later run reads the branch as it stands, a reviewer's commits included, and
 * adds one commit on top: it never replaces what is there. Only a branch left over from a pull request that was
 * merged or closed is started again from the default branch.
 *
 * What adoption found is the one thing the command asks about. Notes written for one person on one machine would
 * otherwise be pushed to the repository's host, and preferences sent to relay's memory, before anybody read them:
 * the command lists them and waits for a yes (`--yes` says it in advance; without a terminal and without `--yes`
 * they are left out and named).
 *
 * Idempotent: a second run with nothing changed makes no model calls and no new commit or pull request. --refresh re-digests
 * stale files and rewrites the summary; --no-digest skips the model steps; --no-adopt leaves Claude Code's files
 * unread; --force overwrites a locally edited owned section. In site mode the stage `events` asks the site whether
 * its GitHub App is installed on the repo and prints the install link; --no-events skips it.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import {
  applyAdoption,
  CONTEXT_DIR,
  digestProject,
  emptyUsage,
  formatUsage,
  ghHost,
  invalidateBriefCache,
  parseRulesState,
  planAdoption,
  planOwnedSection,
  PROFILE_PATH,
  readAdoptState,
  registerProject,
  renderRulesFile,
  repo,
  summarizeProject,
  type GitHost,
} from "@relay/core";
import { worktreesOf } from "./adopt.ts";
import { gitRemoteRepo, gitRoot, humanActor, log, onPath, openReady } from "./_common.ts";
import { eventsCheck, eventsLeft, formatStage, localEventsCheck } from "./events-check.ts";
import { commitOnBase, diskReader, ensureObject, overlayAdoptFs, pushProposal, remoteBase, remoteBranch, treeReader, type RemoteBase, type TreeChange, type TreeReader } from "./_tree.ts";

const LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: "agent:claude", color: "D97757", description: "relay: implement with the Claude lane" },
  { name: "agent:codex", color: "10A37F", description: "relay: implement with the Codex lane" },
  { name: "agent:grok", color: "1DA1F2", description: "relay: implement with the Grok lane" },
  { name: "agent:nodes", color: "E4A11B", description: "relay: run a Griptape Nodes workflow on a worker that has the engine" },
  { name: "deliverable:asset", color: "7057FF", description: "relay: the result is a media asset, not code" },
  // a production's stages (docs/ARCHITECTURE.md "A task's life", the asset path): which step of the film the issue is
  { name: "stage:script", color: "BFD4F2", description: "relay: production stage, the script" },
  { name: "stage:character", color: "BFD4F2", description: "relay: production stage, a character design" },
  { name: "stage:shot", color: "BFD4F2", description: "relay: production stage, a shot" },
  { name: "stage:vo", color: "BFD4F2", description: "relay: production stage, voice-over" },
  { name: "stage:cut", color: "BFD4F2", description: "relay: production stage, the cut" },
];

/** The branch every link proposal goes to: one open pull request per repository, updated in place. */
export const LINK_BRANCH = "relay/link";
const RULES_STATE = ".relay/rules.json";
const RULES_FILE = "relay.md";
/** The caller workflows `relay link --workflows` installed for the GitHub Actions path, recognised by the first line relay wrote. */
const LEGACY_WORKFLOWS = [".github/workflows/relay-caller.yml", ".github/workflows/relay-review.yml", ".github/workflows/relay-cloud.yml"];
const LEGACY_MARK = /^# relay (?:review |cloud )?caller: installed into a repo by `relay link`/;

interface LinkOptions {
  repo?: string;
  project?: string;
  refresh?: boolean;
  force?: boolean;
  digest: boolean;
  maxFiles: string;
  labels: boolean;
  events: boolean;
  adopt: boolean;
  pr: boolean;
  yes?: boolean;
  cwd?: string;
}

export interface LinkDeps {
  /** Where the pull request is opened (default: gh). Tests pass their own. */
  host?: Pick<GitHost, "findPr" | "createPr" | "comment">;
  /** Asks the person a yes/no question (default: the terminal, and no without one). Tests pass their own. */
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * Where the repository's files are read and where relay's changes to them go. For a pull request: `parent` is the
 * commit the proposal is made on, which is the open pull request's own tip when there is one (`open`), so the files
 * are read as a reviewer left them, and the default branch's tip otherwise; `seen` is the branch's tip on origin.
 */
type Target =
  | { kind: "pr"; base: RemoteBase; parent: string; seen: string | undefined; open: { number: number; url: string } | undefined; reader: TreeReader; host: Pick<GitHost, "findPr" | "createPr" | "comment"> }
  | { kind: "tree"; reader: TreeReader; why: string };

/** The terminal's yes or no; no when there is no terminal to ask. */
async function askTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function targetOf(root: string, repoName: string, o: LinkOptions, deps: LinkDeps): Promise<Target> {
  const tree = (why: string): Target => ({ kind: "tree", reader: diskReader(root), why });
  if (!o.pr) return tree("--no-pr");
  const origin = gitRemoteRepo(root);
  if (!origin) return tree("this checkout has no origin remote");
  if (origin !== repoName) return tree(`origin is ${origin}, not ${repoName}`);
  if (!deps.host && !onPath("gh")) return tree("gh is not on PATH, so no pull request can be opened");
  try {
    const base = remoteBase(root);
    const host = deps.host ?? ghHost();
    const seen = remoteBranch(root, LINK_BRANCH);
    const open = seen ? await host.findPr(repoName, LINK_BRANCH) : undefined;
    if (seen && open) ensureObject(root, seen, `refs/heads/${LINK_BRANCH}`);
    const parent = seen && open ? seen : base.sha;
    return { kind: "pr", base, parent, seen, open, reader: treeReader(root, parent), host };
  } catch (e) {
    return tree(`origin's default branch could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
}

function writeTree(root: string, changes: readonly TreeChange[]): void {
  for (const c of changes) {
    const path = join(root, c.path);
    if (c.remove || c.content === undefined) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, c.content);
    }
  }
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the pull request says: each kind of file, why it is there, and what merging does. */
export function proposalBody(changed: readonly string[], removed: readonly string[], facts: { project: string; decisions: number; skipped: number }): string {
  const has = (test: (p: string) => boolean): boolean => changed.some(test);
  const notes = changed.filter((p) => p.startsWith(`${CONTEXT_DIR}/`) && !p.endsWith("/README.md")).length;
  const lines: string[] = [
    `\`relay link\`, run in a checkout of this repository, proposes these files for the relay project \`${facts.project}\`. It changed nothing else, and nothing here takes effect until this is merged: relay's workers read a repository's profile, steps and notes from its default branch only.`,
    "",
  ];
  if (has((p) => p === "AGENTS.md" || p === "CLAUDE.md")) lines.push("- `AGENTS.md` / `CLAUDE.md`: a marked section that points every coding agent at `relay.md`. Only the text between the markers is relay's; the rest of the file is as it was.");
  if (has((p) => p === RULES_FILE)) lines.push("- `relay.md`: the project's current decisions, preferences and summary, rendered from relay's memory. `relay link --refresh` rewrites it.");
  if (has((p) => p === RULES_STATE)) lines.push("- `.relay/rules.json`: which relay project this repository is, and the hash of the section relay wrote, so a later run can tell its own text from an edit.");
  if (notes) lines.push(`- \`${CONTEXT_DIR}/\`: ${plural(notes, "note")} from Claude Code's memory on the machine that ran this, with an index, so a worker on another machine has what was learned here. **Read them before merging**: they become part of the repository.`);
  if (has((p) => p === PROFILE_PATH)) lines.push(`- \`${PROFILE_PATH}\`: a first project profile (setup, verify, tools, capability sets), drafted from the commands that were actually run in this repository. It names environment variables and hosts, never values. Edit it here before merging; a task cannot change it for itself.`);
  if (removed.length) lines.push(`- removed: ${removed.map((p) => `\`${p}\``).join(", ")}, the caller workflows of relay's earlier GitHub Actions path. Tasks now run on relay workers and need no workflow.`);
  if (facts.decisions) lines.push("", `${plural(facts.decisions, "standing preference")} from the same memory went into relay's memory as ${facts.decisions === 1 ? "a decision" : "decisions"} for this project. They are not files, so they are not in this diff; \`relay recall\` shows them.`);
  if (facts.skipped) lines.push("", `${plural(facts.skipped, "note")} ${facts.skipped === 1 ? "was" : "were"} left out; \`relay adopt\` in the checkout says which and why.`);
  return `${lines.join("\n")}\n`;
}

export function registerLink(program: Command, deps: LinkDeps = {}): void {
  program
    .command("link")
    .description("Add this repository to relay with one command: register and digest it, adopt what Claude Code knows about it on this machine, and propose every repository file relay needs (AGENTS.md section, relay.md, docs/context, .relay/project.json) as one pull request")
    .option("--repo <owner/name>", "override the origin remote")
    .option("--project <slug>", "project slug (default: the repo name)")
    .option("--refresh", "re-digest stale files and rewrite the summary and relay.md")
    .option("--force", "overwrite a locally edited owned section")
    .option("--no-digest", "skip the model steps (file digests and the project summary)")
    .option("--max-files <n>", "max files to digest in this run", "400")
    .option("--no-adopt", "leave Claude Code's memory notes and transcripts for this repository unread (relay adopt shows what adopting would do)")
    .option("--no-pr", "write relay's files into this checkout instead of proposing them as a pull request")
    .option("--yes", "include what adoption found without asking: the notes go into the pull request and the preferences into relay's memory (relay adopt lists them first)")
    .option("--no-labels", "skip gh label creation")
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

      const target = await targetOf(root, repoName, o, deps);
      const reader = target.reader;
      log(
        target.kind === "tree"
          ? `repo: relay's files are written into this checkout (${target.why})`
          : target.open
            ? `repo: relay's files go into the open pull request ${target.open.url}, on top of what is on ${LINK_BRANCH} now; this checkout is left as it is`
            : `repo: relay's files go into one pull request against ${target.base.branch} of ${repoName}; this checkout is left as it is`,
      );
      // in a checkout the files are written as each stage makes them, so the digest stage hashes them; a pull request gets them all at the end
      const changes: TreeChange[] = [];
      const put = (batch: TreeChange[]): void => {
        changes.push(...batch);
        if (target.kind === "tree") writeTree(root, batch);
      };

      // the digest cache is always local: the Claude login that writes digests lives on this machine
      const h = await openReady({ local: true });
      try {
        // the cost line is read back from the ledger: every step.usage event newer than the project's latest one now
        const latest = (await repo.listEvents(h.db, { project: slug, limit: 1 }))[0]?.ts ?? "1970-01-01T00:00:00Z";

        // 1. owned sections first, so in a checkout a freshly created AGENTS.md is hashed and digested in the same run
        const sections = planOwnedSection((file) => reader.read(file), parseRulesState(reader.read(RULES_STATE)), { project: slug, repo: repoName, ...(o.force ? { force: true } : {}) });
        for (const s of sections.results) log(`sections: ${s.file} ${s.action}${s.detail ? ` (${s.detail})` : ""}`);
        put([...sections.files.map((f) => ({ path: f.file as string, content: f.content })), ...(sections.stateChanged ? [{ path: RULES_STATE, content: sections.stateText }] : [])]);

        // 2. register + hash; a site learns of the project now, so the decisions adoption records have somewhere to go
        const existed = !!(await repo.getProject(h.db, slug));
        const r = await registerProject(h, { slug, path: root });
        await repo.upsertProject(h.db, { slug, repo: repoName });
        if (h.mode === "site") await h.client.registerProject({ slug, repo: repoName, path: root });
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

        // 5. adoption: no model reads any of it. The decisions go to memory now, before relay.md is rendered from it
        const adopted = { decisions: 0, skipped: 0 };
        if (!o.adopt) log("adopt: skipped (--no-adopt)");
        else {
          try {
            const plan = await planAdoption({ root, project: slug, worktrees: worktreesOf(root), state: readAdoptState(), ...(target.kind === "pr" ? { fs: overlayAdoptFs(root, reader) } : {}) });
            const fresh = { notes: plan.files.filter((f) => f.kind === "context"), profile: plan.files.some((f) => f.kind === "profile"), decisions: plan.decisions.filter((d) => d.action !== "same") };
            const anything = fresh.notes.length > 0 || fresh.profile || fresh.decisions.length > 0;
            // the one question: these were written for one person on one machine, and yes sends them to other people
            let included = !anything || !!o.yes;
            if (anything && !o.yes) {
              const where = target.kind === "pr" ? `pushed to ${repoName} in the pull request` : "written into this checkout";
              log(`adopt: Claude Code's memory for this repository holds ${plural(fresh.notes.length, "note")} that would be ${where}${fresh.decisions.length ? `, and ${plural(fresh.decisions.length, "preference")} that would go into relay's memory${h.mode === "site" ? ` on ${h.client.site}` : ""} and relay.md` : ""}${fresh.profile ? `, with a first ${PROFILE_PATH}` : ""}:`);
              for (const f of fresh.notes) log(`adopt:   ${f.path}  ${f.about.slice(0, 110)}`);
              for (const d of fresh.decisions) log(`adopt:   preference  ${d.text.slice(0, 110)}`);
              included = await (deps.confirm ?? askTerminal)("Include them? Read the notes first if you have not (relay adopt prints them).");
              if (!included) log(`adopt: left out. relay adopt shows each one; relay link --yes includes them, relay link --no-adopt stops asking`);
            }
            if (!plan.found.dirs.length) log("adopt: Claude Code has no memory or transcripts for this repository on this machine");
            else if (included) {
              const result = await applyAdoption(plan, { client: h.client });
              put(result.files);
              adopted.decisions = result.recorded.length;
              adopted.skipped = plan.skipped.length + result.notRecorded.length;
              const notes = plan.files.filter((f) => f.kind === "context").length;
              const already = plan.decisions.filter((d) => d.action === "same").length;
              log(`adopt: ${plural(notes, "note")} to ${CONTEXT_DIR}${plan.unchanged.length ? ` (${plan.unchanged.length} already there)` : ""}, ${plural(result.recorded.length, "preference")} recorded as decisions${already ? ` (${already} already recorded)` : ""}`);
              for (const s of [...plan.skipped, ...result.notRecorded]) log(`adopt: left out ${s.file}: ${s.why}`);
              const p = plan.profile;
              if (plan.files.some((f) => f.kind === "profile")) log(`adopt: ${PROFILE_PATH} drafted from ${plural(plan.commands.bashCalls, "command")} run in ${plural(plan.commands.transcripts, "transcript")}: ${plural(p.draft.setup.length, "setup command")}, ${plural(p.draft.verify.length, "check")}, ${plural(p.draft.tools.length, "tool")}, ${plural(Object.keys(p.draft.sets).length, "capability set")}`);
              else if (p.exists) log(`adopt: ${PROFILE_PATH} is the repository's own and is left alone${p.diff ? "; relay adopt shows what the commands that were run would add to it" : ""}`);
              for (const problem of p.problems) log(`adopt: profile draft: ${problem}`);
            }
          } catch (e) {
            failed = true;
            log(`adopt: FAILED. ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 6. relay.md from the real summary and the decisions; rewritten whenever its content changed
        const project = await repo.getProject(h.db, slug);
        const rules = await renderRulesFile(h.db, slug, { repo: repoName });
        const prev = reader.read(RULES_FILE);
        const noSummary = project?.summary ? "" : "; no project summary yet, run relay link --refresh once claude is logged in";
        if (prev === rules.text) log(`relay.md: unchanged (${rules.tokens} tokens${noSummary})`);
        else {
          put([{ path: RULES_FILE, content: rules.text }]);
          log(`relay.md: ${prev === undefined ? "written" : "updated"} (${rules.tokens} tokens${noSummary})`);
        }

        // 7. the caller workflows of the GitHub Actions path: relay wrote them, nothing runs them any more
        const legacy = LEGACY_WORKFLOWS.filter((path) => LEGACY_MARK.test(reader.read(path) ?? ""));
        if (legacy.length) {
          put(legacy.map((path) => ({ path, remove: true })));
          log(`workflows: ${legacy.join(", ")} removed (relay's earlier GitHub Actions path; workers need none)`);
        }

        // 8. the pull request: one commit beside the checkout, one branch, one pull request that a later run updates
        let prUrl: string | undefined;
        if (target.kind === "tree") log(changes.length ? `repo: ${plural(changes.length, "file")} changed in this checkout (${changes.map((c) => c.path).join(", ")})` : "repo: every file is current");
        else {
          try {
            const message = target.open
              ? `Update relay's files\n\nAdded by relay link for the project ${slug}, on top of what the pull request already holds.`
              : `Link this repository to relay\n\nProposed by relay link for the project ${slug}: the agent rules section, relay.md, and what was adopted from\nClaude Code's memory on the machine that ran it. Nothing here takes effect until it is merged.`;
            const proposal = commitOnBase(root, target.parent, changes, message);
            if (!proposal.changed.length) {
              if (target.open) {
                prUrl = target.open.url;
                log(`pull request: ${target.open.url} already holds every file; nothing added`);
              } else log(`pull request: none needed, ${target.base.branch} has every file`);
            } else {
              // on an open pull request this only adds a commit; a branch left from a merged or closed one is started again
              pushProposal(root, proposal.sha, LINK_BRANCH, target.seen);
              const effective = changes.filter((c) => proposal.changed.includes(c.path));
              const body = proposalBody(proposal.changed, effective.filter((c) => c.remove).map((c) => c.path), { project: slug, ...adopted });
              const pr = target.open ?? (await target.host.createPr(repoName, { base: target.base.branch, head: LINK_BRANCH, title: "Link this repository to relay", body }));
              // the description was written for the first proposal; what a later run adds is said where the reviewer will see it
              if (target.open) await target.host.comment(repoName, pr.number, `relay link added a commit to this pull request.\n\n${body}`).catch((e: unknown) => log(`pull request: the commit is there, but the comment that describes it was not posted (${(e instanceof Error ? e.message : String(e)).slice(0, 160)})`));
              prUrl = pr.url;
              log(`pull request: ${pr.url} (${target.open ? "one commit added" : "opened"}; ${plural(proposal.changed.length, "file")}: ${proposal.changed.join(", ")})`);
            }
          } catch (e) {
            failed = true;
            log(`pull request: FAILED. ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}. relay link --no-pr writes the files into this checkout instead`);
          }
        }

        // 9. lane labels
        if (o.labels) {
          const gh = onPath("gh");
          if (!gh) log("labels: gh not on PATH; create agent:claude|codex|grok|nodes and deliverable:asset by hand");
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
        await repo.writeEvent(h.db, { kind: "project.linked", actor: humanActor(), project: slug, repo: repoName, summary: `${repoName} linked at ${root}`, payload: { path: root, refresh: !!o.refresh, digest: o.digest, calls: usage.calls, ...(prUrl ? { pr: prUrl } : {}) } });

        // 10. site mode: the project, its digests and the summary go up through the API; the login never does
        if (h.mode === "site") {
          const site = h.client;
          const uploads = usageRows.map((e) => ({ lane: e.lane ?? "digest", model: e.model, subscription: e.subscription, tokens_in: e.tokens_in, tokens_out: e.tokens_out, cache_read: e.cache_read, cache_write: e.cache_write, cost_equiv: e.cost_equiv, duration_ms: e.duration_ms, summary: e.summary, ts: e.ts }));
          await site.registerProject({ slug, repo: repoName, path: root, ...(project?.stack ? { stack: project.stack } : {}), ...(project?.check_cmd ? { checkCmd: project.check_cmd } : {}) });
          const digests = await repo.listFileDigests(h.db, slug);
          const up = await site.putDigests(slug, digests.map((d) => ({ path: d.path, sha256: d.sha256, size: d.size, summary: d.summary, summary_sha: d.summary_sha, tokens: d.tokens })), { prune: true, usage: uploads });
          if (project?.summary) await site.putSummary(slug, project.summary, project.summary_tokens ?? 0);
          log(`site: ${site.site} has ${slug} with ${up.files} file digests${project?.summary ? " and the summary" : ""}${uploads.length ? `, ${uploads.length} usage rows` : ""}`);
        }

        // 11. events: do GitHub's deliveries for this repo reach the store? Advice only; never fails the link. After the
        // site upload, so a first link finds its project on the site.
        const left: string[] = [];
        if (prUrl) left.push(`merge ${prUrl} (read the notes and the profile in it first); until then workers see none of these files`);
        if (target.kind === "tree" && changes.length) left.push("commit the changed files and get them onto the default branch, where workers read them");
        if (o.events) {
          if (h.mode !== "site") log(formatStage(localEventsCheck()));
          else {
            const site = h.client.site!;
            try {
              const status = await h.client.githubStatus(slug);
              if (!status) log(formatStage({ status: "warn", name: "events", detail: `${site} does not know project ${slug} yet; re-run relay link` }));
              else {
                log(formatStage(eventsCheck(status, site)));
                const install = eventsLeft(status, site);
                if (install) left.push(install);
              }
            } catch (e) {
              log(formatStage({ status: "warn", name: "events", detail: `could not check GitHub events on ${site}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` }));
            }
          }
        }
        log(`cost: ${formatUsage(usage)}`);
        for (const l of left) log(`left: ${l}`);
        if (!left.length && !failed) log(`done: ${slug} is linked; open its first task with relay task create --title "…" --lane any`);
        if (failed) process.exitCode = 1;
      } finally {
        await h.close();
      }
    });
}
