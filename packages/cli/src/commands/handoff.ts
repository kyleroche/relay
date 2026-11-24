/**
 * `relay handoff`: turn the work a session has in progress into a task a worker finishes. The worker is a stranger:
 * it gets a clone, the task's text and relay's memory, and nothing of the conversation. So the text has to be a
 * brief (the goal, the files that matter, what is out of scope, the command that proves it is done), and with
 * `--push` the uncommitted work goes along as a branch the task starts from.
 *
 * `--push` leaves the checkout exactly as it is: the work is staged into a temporary index (`GIT_INDEX_FILE`), made
 * a commit on top of `HEAD` with `git commit-tree`, and that commit is pushed by its hash. The working tree, the real
 * index and the current branch are never written.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { board, isLaneName, laneNameProblem } from "@relay/core";
import { gitRemoteRepo, log, resolveProject } from "./_common.ts";
import { act, openBoard, repoOf } from "./_board.ts";

export const BODY_HELP =
  "a handoff needs a brief: the worker that takes it has a clone and this text, and none of the conversation. Write, in --body-file (or - for stdin): " +
  "the goal (what is true when this is done); the files that matter (where the work is, what to read first); what is out of scope (what not to touch); " +
  "and the command that proves it is done (the test or check to run, and what it should show)";

export interface WorkInProgress {
  /** `relay/handoff-<8 hex of the commit>`, on origin. */
  branch: string;
  /** The commit the branch points at: a new one holding the uncommitted work, or `HEAD` itself when there was none. */
  sha: string;
  head: string;
  /** Files that differ from `HEAD` in the commit: modified, deleted, and new ones git does not ignore. */
  files: string[];
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  }
}

/** Files that differ from `HEAD` in the working tree, new files included and ignored ones not: what a handoff without `--push` leaves behind. */
export function uncommitted(root: string): string[] {
  return git(root, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).map((l) => l.slice(3));
}

/**
 * The working tree as a commit on top of `HEAD`, without touching the tree, the index or the branch. `message` is
 * the commit's; the author is whoever git says the user is.
 */
export function commitWorkInProgress(root: string, message: string): { sha: string; head: string; files: string[] } {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const scratch = mkdtempSync(join(tmpdir(), "relay-handoff-"));
  try {
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    // start from HEAD's tree, so a tracked file that an ignore rule now matches stays tracked; then everything the tree holds that git does not ignore
    git(root, ["read-tree", "HEAD"], index);
    git(root, ["add", "-A"], index);
    const tree = git(root, ["write-tree"], index);
    if (tree === git(root, ["rev-parse", "HEAD^{tree}"])) return { sha: head, head, files: [] };
    const files = git(root, ["diff-tree", "-r", "--name-only", "--no-renames", head, tree]).split("\n").filter(Boolean);
    return { sha: git(root, ["commit-tree", tree, "-p", head, "-m", message]), head, files };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Push the work in progress to origin as `relay/handoff-<8 hex>`. The checkout is left as it was. */
export function pushWorkInProgress(root: string, title: string): WorkInProgress {
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  const at = git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const made = commitWorkInProgress(toplevel, `relay handoff: ${title}\n\nWork in progress from ${at === "HEAD" ? "a detached HEAD" : at}, handed to a worker by relay handoff.`);
  const branch = `relay/handoff-${made.sha.slice(0, 8)}`;
  git(toplevel, ["push", "--quiet", "origin", `${made.sha}:refs/heads/${branch}`]);
  return { branch, ...made };
}

export interface HandoffDeps {
  /** The board to open the task on (default: this machine's). Tests pass one in memory. */
  openBoard?: () => board.Board | Promise<board.Board>;
}

export function registerHandoff(program: Command, deps: HandoffDeps = {}): void {
  program
    .command("handoff")
    .requiredOption("--title <text>")
    .requiredOption("--lane <lane>", `the lane that finishes it: ${board.ANY_LANE}, a built-in lane, or one a worker registered (relay work status)`)
    .option("--body-file <path>", "the brief: the goal, the files that matter, what is out of scope, the command that proves it is done ('-' for stdin)")
    .option("--push", "send the uncommitted work along: a branch relay/handoff-<8 hex> on origin that the task starts from; the working tree, index and branch stay as they are")
    .option("--model <id>", "the model the lane should use; the lane's default without it")
    .option("--project <slug>", "project slug (default: the linked project of the cwd)")
    .option("--cwd <path>")
    .option("--json")
    .description("Hand work in progress to a worker: open a task from a brief, with the uncommitted work as its starting branch when --push is given")
    .action(async (o: { title: string; lane: string; bodyFile?: string; push?: boolean; model?: string; project?: string; cwd?: string; json?: boolean }) => {
      if (!isLaneName(o.lane)) throw new Error(`--lane: ${laneNameProblem(o.lane)}`);
      const body = o.bodyFile ? readFileSync(o.bodyFile === "-" ? 0 : o.bodyFile, "utf8").trim() : "";
      if (!body) throw new Error(BODY_HELP);
      const ref = resolveProject({ ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.project ? { project: o.project } : {}) });
      if (!ref.slug) throw new Error("no project: pass --project or run relay link in the repo");
      const slug = ref.slug;
      const repo = await repoOf(slug, ref);
      if (!repo) throw new Error(`no repository for project '${slug}': register it with relay project add ${slug} --repo owner/name`);
      const origin = gitRemoteRepo(ref.root);
      // the branch goes to this checkout's origin and the worker clones the project's repository: they have to be the same one
      if (o.push && origin !== repo) throw new Error(`--push would send the branch to ${origin ?? "a checkout with no origin"}, and the project's tasks are cloned from ${repo}; run it in a checkout of ${repo}`);

      // filled in as it goes, so a refusal after the push can still name the branch
      const done: { sent?: WorkInProgress; opened: boolean } = { opened: false };
      await act(async () => {
        const b = await (deps.openBoard ?? openBoard)();
        // the same refusal openServedTask makes, asked before anything is pushed: a lane nobody serves leaves no branch behind
        const unserved = board.laneUnservedProblem(o.lane, board.servedLanes(await board.listWorkers(b)));
        if (unserved) throw new board.TaskError(unserved, 400);
        const sent = o.push ? (done.sent = pushWorkInProgress(ref.root, o.title)) : undefined;
        const left = sent ? [] : uncommitted(ref.root);
        const start = sent
          ? `\n\n---\nWork in progress is on the branch \`${sent.branch}\`, which this task starts from${sent.files.length ? `: ${sent.files.length} file${sent.files.length === 1 ? "" : "s"} changed on top of ${sent.head.slice(0, 8)} and not committed by the person who handed it off` : " (nothing was uncommitted; it is the handing-off checkout's HEAD)"}. Continue it; do not start over.`
          : "";
        const { task: t } = await board.openServedTask(b, { project: slug, repo, title: o.title, body: `${body}${start}`, lane: o.lane, ...(o.model ? { model: o.model } : {}), ...(sent ? { base: sent.branch } : {}) });
        done.opened = true;
        if (o.json) console.log(JSON.stringify({ task: t, ...(sent ? { branch: sent.branch, sha: sent.sha, files: sent.files } : { not_sent: left }) }, null, 2));
        else {
          console.log(t.id);
          log(`opened in ${t.channel} [${t.state}]${t.hold ? `: ${t.hold.reason}` : ""}`);
          if (sent) log(`starts from ${sent.branch} (${sent.sha.slice(0, 8)}): ${sent.files.length ? `${sent.files.length} uncommitted file${sent.files.length === 1 ? "" : "s"} sent` : "HEAD as it is, nothing was uncommitted"}; this checkout is unchanged. The worker's pull request will be against ${sent.branch}`);
          else log(`starts from the repository's default branch${left.length ? `; the uncommitted work here was NOT sent (${left.length} file${left.length === 1 ? "" : "s"}: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ", …" : ""}). --push sends it` : ""}; commits that are not on the default branch are not part of it either`);
        }
      });
      if (done.sent && !done.opened) log(`no task was opened, and ${done.sent.branch} is on origin: run this again once the refusal above is settled, or remove it with git push origin --delete ${done.sent.branch}`);
    });
}
