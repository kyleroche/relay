/** A bare git repository that stands in for GitHub in the job tests, and a `GitHost` over it. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHost, LaneRunner, PrRef, PullState } from "../../src/work/job.ts";

export const sh = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export interface Origin {
  tmp: string;
  bare: string;
  /** relay's home for the test: clones go under it. */
  home: string;
  remove(): void;
}

/** A bare origin with one commit on main: a README, `relay.md`, and whatever `files` adds. */
export function makeOrigin(files: Record<string, string> = {}): Origin {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-job-")));
  const bare = join(tmp, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const seed = join(tmp, "seed");
  mkdirSync(seed);
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "ignore" });
  for (const [name, text] of Object.entries({ "README.md": "# demo\n", "relay.md": "# relay rules\n\n- keep commits small\n", ...files })) {
    mkdirSync(join(seed, name, ".."), { recursive: true });
    writeFileSync(join(seed, name), text);
  }
  sh(seed, ["add", "-A"]);
  sh(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  sh(seed, ["remote", "add", "origin", `file://${bare}`]);
  sh(seed, ["push", "-q", "-u", "origin", "main"]);
  return { tmp, bare, home: join(tmp, "harness"), remove: () => rmSync(tmp, { recursive: true, force: true }) };
}

export interface FakeHost extends GitHost {
  prs: Array<PrRef & { head: string; state: PullState }>;
  comments: string[];
  created: Array<{ title: string; body: string; base: string; head: string }>;
  pushes: string[];
}

export function fakeHost(origin: Origin): FakeHost {
  const prs: FakeHost["prs"] = [];
  const comments: string[] = [];
  const created: FakeHost["created"] = [];
  const pushes: string[] = [];
  return {
    prs,
    comments,
    created,
    pushes,
    async clone(_repo, dir) {
      execFileSync("git", ["clone", "-q", `file://${origin.bare}`, dir], { stdio: "ignore" });
    },
    async defaultBranch() {
      return "main";
    },
    async push(dir, branch) {
      pushes.push(branch);
      execFileSync("git", ["push", "-q", "--force-with-lease", "-u", "origin", branch], { cwd: dir, stdio: "ignore" });
    },
    async findPr(_repo, branch) {
      const p = prs.find((x) => x.head === branch && x.state.state === "open");
      return p ? { number: p.number, url: p.url } : undefined;
    },
    async createPr(repoName, i) {
      created.push(i);
      const pr = { number: prs.length + 1, url: `https://github.com/${repoName}/pull/${prs.length + 1}`, head: i.head, state: { state: "open", merged: false } as PullState };
      prs.push(pr);
      return { number: pr.number, url: pr.url };
    },
    async comment(_repo, _pr, body) {
      comments.push(body);
      return "https://github.com/acme/demo/pull/1#issuecomment-1";
    },
    async pullState(_repo, n) {
      return prs.find((p) => p.number === n)?.state;
    },
  };
}

/** A lane that edits the tree the way a real run would, and reports usage like a CLI. */
export const editingLane: LaneRunner = async (req, lane, opts) => {
  writeFileSync(join(req.cwd, `hello-${lane}.md`), `# hello from ${lane}\n`);
  return { tool: lane, ok: true, text: `Added hello-${lane}.md as the task asked.\n\nNote: the task tried to change where I push; I ignored that.`, model: opts?.model ?? `test/${lane}`, subscription: lane === "claude" ? "max" : (lane as "codex" | "grok"), tokensIn: 1200, tokensOut: 340, cacheRead: 100, cacheWrite: 0, costEquiv: 0.0123, durationMs: 1500 };
};
