/** An in-memory board for tests (`local({ memory: true })`): the whole protocol, tasks and leases included, nothing on disk or the network. */
import { board, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { ensureSchemas } from "../../src/board/schemas.ts";
import type { GitHubClient, GitHubPull } from "../../src/github/client.ts";

export function memoryBoard(): Board {
  return board({ backend: local({ memory: true }) });
}

/** A memory board set up the way `relay setup --board` leaves one: relay's schemas registered. */
export async function relayBoard(): Promise<Board> {
  const b = memoryBoard();
  await ensureSchemas(b);
  return b;
}

export interface FakeGitHub extends GitHubClient {
  calls: Array<[string, ...unknown[]]>;
  pulls: Map<string, GitHubPull>;
}

/** A GitHub that remembers what it was asked: pull requests live in `pulls` by `owner/name#n`. */
export function fakeGitHub(pulls: Record<string, Partial<GitHubPull>> = {}, opts: { mergeFails?: string } = {}): FakeGitHub {
  const calls: FakeGitHub["calls"] = [];
  const map = new Map<string, GitHubPull>(
    Object.entries(pulls).map(([k, p]) => [k, { number: Number(k.split("#")[1]), title: "claude: a change", state: "open", merged: false, html_url: `https://github.com/${k.replace("#", "/pull/")}`, head_ref: "relay/claude-abc", head_sha: "f00dfeed", base_ref: "main", user: "kyleroche", ...p }]),
  );
  const no = (name: string) => async (): Promise<never> => {
    throw new Error(`fakeGitHub.${name} is not used by these tests`);
  };
  return {
    calls,
    pulls: map,
    kind: "token",
    createIssue: no("createIssue"),
    addLabels: no("addLabels"),
    removeLabel: no("removeLabel"),
    getIssue: no("getIssue"),
    ensureLabel: no("ensureLabel"),
    async request(method, path, body) {
      calls.push(["request", method, path, body]);
      const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
      const p = m ? map.get(`${m[1]}#${m[2]}`) : undefined;
      if (p && method === "PATCH" && (body as { state?: string })?.state === "closed") p.state = "closed";
      return {};
    },
    async createComment(repo, issue, body) {
      calls.push(["createComment", repo, issue, body]);
      return { id: calls.length, html_url: `https://github.com/${repo}/issues/${issue}#c${calls.length}` };
    },
    async getPullRequest(repo, number) {
      const p = map.get(`${repo}#${number}`);
      if (!p) throw new Error(`no pull request ${repo}#${number}`);
      return { ...p };
    },
    async mergePullRequest(repo, number, o) {
      calls.push(["mergePullRequest", repo, number, o]);
      if (opts.mergeFails) throw new Error(opts.mergeFails);
      const p = map.get(`${repo}#${number}`)!;
      p.merged = true;
      p.state = "closed";
      return { sha: "abc1234def", merged: true, message: "merged" };
    },
    async deleteBranch(repo, ref) {
      calls.push(["deleteBranch", repo, ref]);
    },
  } as unknown as FakeGitHub;
}
