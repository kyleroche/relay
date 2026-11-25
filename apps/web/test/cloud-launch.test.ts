/**
 * A plan turned into sandbox calls (lib/cloud/launch.ts), against a sandbox that only remembers what it was asked:
 * no test creates a real one. Two things matter here. Where the three credentials are (the firewall's rules) and
 * where they are not (anything the sandbox can read). And, since the lane in there can run any code, what each
 * credential is usable for: which requests the rules sign, which they refuse, and what the board and GitHub would
 * let a signed request do. `answer` below reads the rules as the firewall is documented to: in order, the first
 * that matches handles the request, and a request no rule matches goes out as it is.
 */
import { describe, expect, it } from "vitest";
import type { NetworkPolicyRule } from "@vercel/sandbox";
import { CLOUD_PLACEHOLDER, cloudNames, cloudRunPlan, type CloudRunPlan } from "@relay/core";
import { boardPolicyProblem, cloudEnv, CloudLaunchError, cloudNetworkPolicy, credentialsIn, GITHUB_REFUSED, githubRules, githubTokenProblem, launch, type CloudSandbox, type CloudSandboxParams, type CloudSecrets } from "../lib/cloud/launch.ts";

const BOARD_JWT = "fake-header.fake-board-oidc-token-of-the-deployment.fake-signature";
const GITHUB = "fake-github-installation-token-for-one-repository";
const GATEWAY = "fake-model-gateway-key-of-the-owner";

const TASK = { id: "790.771", project: "atlas-site" };
const PROFILE = cloudNames(TASK.id).profile;
const CAN = "work/atlas-site=read,post,react,label;relay/workers=read,post,label";
const NARROW = { contents: "write", metadata: "read", pull_requests: "write" };
const BASIC = `Basic ${Buffer.from(`x-access-token:${GITHUB}`).toString("base64")}`;

const plan = (over: Partial<Parameters<typeof cloudRunPlan>[0]> = {}): CloudRunPlan => cloudRunPlan({ task: TASK, cap: 2, relayVersion: "0.3.2", hosts: ["api.example-cms.com"], start: { grant: "790.800", n: 1 }, ...over });

/** The board's policy for a sandbox, as `sandboxPolicy()` makes it: the credential, who it writes as, what it may do. */
const boardAllow = (headers: Record<string, string> = { "x-board-profile": PROFILE, "x-board-can": CAN }): CloudSecrets["board"]["allow"] => ({
  "api.vercel.com": [{ match: { method: ["GET"], path: { startsWith: "/v1/messageboard/boards/b1/" } }, transform: [{ headers: { authorization: `Bearer ${BOARD_JWT}`, ...headers } }] }, { response: { statusCode: 403 } }],
});

const secrets = (over: Partial<CloudSecrets> = {}): CloudSecrets => ({
  board: { allow: boardAllow(), env: { BOARD_URL: "https://api.vercel.com/v1/messageboard/boards/b1", BOARD_TOKEN: "placeholder" } },
  github: { repo: "acme/atlas-site", token: GITHUB, permissions: { ...NARROW } },
  gateway: GATEWAY,
  from: ["vercel:project:p1:production", "vercel:user:u1"],
  ...over,
});

/** The refusal a launch ends in. */
const refusal = (run: Promise<void>): Promise<CloudLaunchError> =>
  run.then(
    () => {
      throw new Error("expected the launch to fail");
    },
    (e: unknown) => e as CloudLaunchError,
  );

interface Fake {
  created: CloudSandboxParams[];
  ran: Array<{ cmd: string; args: string[]; env?: Record<string, string>; detached?: boolean }>;
  stopped: number;
  create(params: CloudSandboxParams): Promise<CloudSandbox>;
}

/** A sandbox whose commands exit as `exits` says, by the command's name; 0 without an entry. */
function fake(exits: Record<string, number | Error> = {}, opts: { stopFails?: boolean } = {}): Fake {
  const f: Fake = {
    created: [],
    ran: [],
    stopped: 0,
    async create(params) {
      f.created.push(params);
      return {
        async runCommand(c) {
          f.ran.push(c);
          const exit = exits[c.cmd] ?? 0;
          if (exit instanceof Error) throw exit;
          return { exitCode: exit, stderr: async () => (exit ? `npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org failed\n` : "") };
        },
        async stop() {
          f.stopped++;
          if (opts.stopFails) throw new Error("stop refused");
        },
      };
    },
  };
  return f;
}

/** What the firewall does with one request to a host: adds a credential, answers it itself, or lets it out as it is. */
function answer(rules: readonly NetworkPolicyRule[], method: string, path: string): { signed: string } | { status: number } | "plain" {
  const hit = (m: NonNullable<NetworkPolicyRule["match"]>): boolean => {
    if (m.method && !m.method.includes(method)) return false;
    const p = m.path as { exact?: string; startsWith?: string; regex?: string } | undefined;
    if (!p) return true;
    if (p.exact !== undefined) return path === p.exact;
    if (p.startsWith !== undefined) return path.startsWith(p.startsWith);
    return p.regex !== undefined && new RegExp(p.regex).test(path);
  };
  for (const rule of rules) {
    if (rule.match && !hit(rule.match)) continue;
    if (rule.response) return { status: rule.response.statusCode };
    return { signed: rule.transform?.[0]?.headers?.authorization ?? "" };
  }
  return "plain";
}
const api = (method: string, path: string, repo = "acme/atlas-site") => answer(githubRules(repo, GITHUB)["api.github.com"], method, path);
const git = (method: string, path: string, repo = "acme/atlas-site") => answer(githubRules(repo, GITHUB)["github.com"], method, path);
const REFUSED = { status: 403 };

describe("what the GitHub credential is usable for", () => {
  it("refuses the REST merge paths, however the repository is spelled or named", () => {
    for (const path of [
      "/repos/acme/atlas-site/pulls/7/merge",
      "/repos/acme/atlas-site/pulls/7/merge/",
      "/repos/ACME/Atlas-Site/pulls/7/merge",
      "/REPOS/acme/atlas-site/PULLS/7/MERGE",
      "/repositories/123456/pulls/7/merge",
      "/repos/acme/atlas-site/merges",
      "/repos/Acme/atlas-site/merges/",
      "/repositories/123456/merges",
      "/repos/acme/another/pulls/1/merge",
    ])
      for (const method of ["PUT", "POST", "GET", "PATCH"]) expect(api(method, path), `${method} ${path}`).toEqual(REFUSED);
    // by name, before any rule that signs is looked at
    const first = githubRules("acme/atlas-site", GITHUB)["api.github.com"].slice(0, GITHUB_REFUSED.length);
    expect(first.every((r) => r.response?.statusCode === 403 && !r.transform)).toBe(true);
    expect(first[0]!.response!.body).toBe("A paid run does not merge a pull request.");
  });

  it("refuses moving or deleting a branch through the API, and branch protection and rulesets altogether", () => {
    for (const [method, path] of [
      ["DELETE", "/repos/acme/atlas-site/git/refs/heads/main"],
      ["PATCH", "/repos/acme/atlas-site/git/refs/heads/main"],
      ["POST", "/repos/acme/atlas-site/git/refs"],
      ["DELETE", "/repos/ACME/atlas-site/git/refs/heads/relay/claude-0a1b2c3d"],
      ["DELETE", "/repositories/123456/git/refs/tags/v1.0.0"],
      ["GET", "/repos/acme/atlas-site/branches/main/protection"],
      ["PUT", "/repos/acme/atlas-site/branches/main/protection"],
      ["DELETE", "/repos/acme/atlas-site/branches/main/protection"],
      ["DELETE", "/repos/acme/atlas-site/branches/release/1.x/protection/required_pull_request_reviews"],
      ["POST", "/repos/acme/atlas-site/rulesets"],
      ["PUT", "/repos/acme/atlas-site/rulesets/42"],
      ["DELETE", "/repos/Acme/Atlas-Site/rulesets/42"],
      ["GET", "/repos/acme/atlas-site/rules/branches/main"],
    ] as const)
      expect(api(method, path), `${method} ${path}`).toEqual(REFUSED);
  });

  it("signs no REST write at all: gh makes none in a job", () => {
    for (const [method, path] of [
      ["POST", "/repos/acme/atlas-site/pulls"],
      ["PATCH", "/repos/acme/atlas-site/pulls/7"],
      ["POST", "/repos/acme/atlas-site/pulls/7/reviews"],
      ["POST", "/repos/acme/atlas-site/issues/7/comments"],
      ["PUT", "/repos/acme/atlas-site/contents/README.md"],
      ["POST", "/repos/acme/atlas-site/git/commits"],
      ["POST", "/repos/acme/atlas-site/releases"],
      ["POST", "/repos/acme/atlas-site/dispatches"],
      ["POST", "/repos/acme/atlas-site/actions/workflows/ci.yml/dispatches"],
      ["PUT", "/repos/acme/atlas-site/actions/secrets/NPM_TOKEN"],
      ["POST", "/repos/acme/atlas-site/hooks"],
      ["POST", "/repos/acme/atlas-site/keys"],
      ["PUT", "/repos/acme/atlas-site/collaborators/mallory"],
      ["PATCH", "/repos/acme/atlas-site"],
      ["DELETE", "/repos/acme/atlas-site"],
      ["POST", "/repos/acme/atlas-site/forks"],
      ["POST", "/"],
      ["GET", "/graphql"],
      ["put", "/repos/acme/atlas-site/pulls/7/merge"],
    ] as const)
      expect(api(method, path), `${method} ${path}`).toEqual(REFUSED);
    const signing = githubRules("acme/atlas-site", GITHUB)["api.github.com"].filter((r) => r.transform);
    expect(signing.map((r) => [r.match!.method, r.match!.path])).toEqual([
      [["GET"], { exact: "/" }],
      [["POST"], { exact: "/graphql" }],
      [["GET", "HEAD"], { regex: "^/repos/acme/atlas-site(/.*)?$" }],
    ]);
  });

  it("signs what git and gh need for the one repository", () => {
    const bearer = { signed: `Bearer ${GITHUB}` };
    // gh auth login reads the token's scopes at the root; gh repo view, pr view, pr create and pr comment are GraphQL
    expect(api("GET", "/")).toEqual(bearer);
    expect(api("POST", "/graphql")).toEqual(bearer);
    for (const path of ["/repos/acme/atlas-site", "/repos/acme/atlas-site/pulls", "/repos/acme/atlas-site/pulls/7", "/repos/acme/atlas-site/contents/.relay/project.json", "/repos/acme/atlas-site/git/refs/heads/main"]) expect(api("GET", path), path).toEqual(bearer);
    for (const path of ["/acme/atlas-site.git/info/refs", "/acme/atlas-site/info/refs"]) expect(git("GET", path), path).toEqual({ signed: BASIC });
    for (const path of ["/acme/atlas-site.git/git-upload-pack", "/acme/atlas-site.git/git-receive-pack", "/acme/atlas-site/git-receive-pack"]) expect(git("POST", path), path).toEqual({ signed: BASIC });
  });

  it("cannot keep a merge out of /graphql, nor a push off the default branch: the firewall sees a path, not a body or a ref", () => {
    // written down as a test so nobody reads the rules above as more than they are. A `mergePullRequest` mutation is
    // a POST to /graphql like `gh pr create`'s own, and `git push origin HEAD:main` is the same request as a push of
    // the run's branch. Both are signed. What stops them is the repository's branch rule (lib/cloud/guard.ts).
    expect(api("POST", "/graphql")).toEqual({ signed: `Bearer ${GITHUB}` });
    expect(git("POST", "/acme/atlas-site.git/git-receive-pack")).toEqual({ signed: BASIC });
  });

  it("gives another repository's paths no token, on either host", () => {
    for (const path of [
      "/repos/acme/other",
      "/repos/acme/other/contents/README.md",
      "/repos/other/atlas-site",
      "/repos/acme/atlas-site-fork/pulls",
      "/repos/acme/atlas-siteX",
      "/repos/acme/atlasXsite",
      "/repos/Acme/Atlas-Site/pulls",
      "/repos/acme",
      "/repositories/123456",
      "/user",
      "/user/repos",
      "/orgs/acme/repos",
      "/installation/repositories",
      "/search/code",
      "/gists",
      "/app",
      "/x/repos/acme/atlas-site",
    ])
      expect(api("GET", path), path).toEqual(REFUSED);
    for (const [method, path] of [
      ["GET", "/acme/other.git/info/refs"],
      ["POST", "/acme/other.git/git-receive-pack"],
      ["GET", "/other/atlas-site.git/info/refs"],
      ["GET", "/acme/atlas-site-fork.git/info/refs"],
      ["POST", "/mallory/drop.git/git-receive-pack"],
      ["GET", "/x/acme/atlas-site/info/refs"],
      // the repository itself, anywhere but git's three endpoints
      ["GET", "/acme/atlas-site"],
      ["GET", "/acme/atlas-site/settings/branches"],
      ["GET", "/acme/atlas-site/archive/refs/heads/main.zip"],
      ["POST", "/acme/atlas-site.git/info/refs"],
      ["GET", "/acme/atlas-site.git/git-receive-pack"],
      ["POST", "/acme/atlas-site.git/git-receive-pack/x"],
      ["GET", "/login"],
    ] as const)
      expect(git(method, path), `${method} ${path}`).toEqual(REFUSED);
    // a dot in a name is a dot, not any character
    expect(git("GET", "/acme/atlas.site.git/info/refs", "acme/atlas.site")).toEqual({ signed: BASIC });
    expect(git("GET", "/acme/atlasXsite.git/info/refs", "acme/atlas.site")).toEqual(REFUSED);
    expect(api("GET", "/repos/acme/atlasXsite/pulls", "acme/atlas.site")).toEqual(REFUSED);
  });

  it("lets nothing to GitHub out unanswered: each host's last rule refuses whatever the others did not claim", () => {
    for (const rules of Object.values(githubRules("acme/atlas-site", GITHUB))) {
      expect(rules.at(-1)).toMatchObject({ response: { statusCode: 403 } });
      expect(rules.at(-1)!.match).toBeUndefined();
    }
    for (const [method, path] of [["GET", "/anything"], ["TRACE", "/"], ["POST", "/repos/acme/atlas-site/pulls/7/merge?x=1"]] as const) {
      expect(api(method, path)).not.toBe("plain");
      expect(git(method, path)).not.toBe("plain");
    }
  });

  it("has no rules for a repository that is not owner/name", () => {
    for (const repo of ["", "acme", "acme/atlas/site", "acme/..", "../atlas-site", "acme/atlas site", "acme/(.*)", "acme/atlas-site/"]) expect(() => githubRules(repo, GITHUB), repo).toThrow(CloudLaunchError);
  });

  it("is a token that may push and open a pull request, and is not used when GitHub says it may do more", async () => {
    expect(githubTokenProblem(plan(), NARROW)).toBeUndefined();
    expect(githubTokenProblem(plan(), { contents: "read", metadata: "read" })).toBeUndefined();
    expect(githubTokenProblem(plan(), { ...NARROW, issues: "write", actions: "read" })).toMatch(/issues: write, actions: read/);
    expect(githubTokenProblem(plan(), { ...NARROW, administration: "write" })).toMatch(/administration: write/);
    expect(githubTokenProblem(plan(), { ...NARROW, metadata: "write" })).toMatch(/metadata: write/);
    // every permission relay's App holds, which is what an unnarrowed mint returns
    const f = fake();
    const wide = secrets({ github: { repo: "acme/atlas-site", token: GITHUB, permissions: { actions: "read", contents: "write", deployments: "read", issues: "write", metadata: "read", pull_requests: "write" } } });
    await expect(launch(plan(), wide, f.create)).rejects.toThrow(/may do more than a run needs \(actions: read, deployments: read, issues: write\); not starting it/);
    expect(f.created).toEqual([]);
  });
});

describe("what the board credential is usable for", () => {
  it("is held to the task's own queue and the workers channel, as the worker's profile", () => {
    expect(boardPolicyProblem(plan(), boardAllow())).toBeUndefined();
    expect(plan().board).toEqual({ "work/atlas-site": ["read", "post", "react", "label"], "relay/workers": ["read", "post", "label"] });
    // the order of entries and of permissions is the board's to choose
    expect(boardPolicyProblem(plan(), boardAllow({ "x-board-profile": PROFILE, "x-board-can": "relay/workers=label,post,read;work/atlas-site=label,post,react,read" }))).toBeUndefined();
  });

  it("is not started with another project's queue, every queue, or more than a worker does in reach", async () => {
    for (const can of [
      "work/=read,post,react,label;relay/workers=read,post,label",
      "work/atlas-site=read,post,react,label;work/nightfall=read,post,react,label;relay/workers=read,post,label",
      "work/nightfall=read,post,react,label;relay/workers=read,post,label",
      "work/atlas-site=read,post,react,label;relay/workers=read,post,label;relay/=read",
      "work/atlas-site=read,post,react,label,manage;relay/workers=read,post,label",
      "work/atlas-site=all;relay/workers=read,post,label",
      "*=read,post,react,label",
      "work/atlas-site=read,post,react,label",
      "",
    ]) {
      const allow = boardAllow({ "x-board-profile": PROFILE, "x-board-can": can });
      expect(boardPolicyProblem(plan(), allow), can).toMatch(/not what the plan says \(work\/atlas-site, relay\/workers\)/);
      const f = fake();
      await expect(launch(plan(), secrets({ board: { ...secrets().board, allow } }), f.create), can).rejects.toThrow(CloudLaunchError);
      expect(f.created).toEqual([]);
    }
    // a policy that names no limit at all leaves the sandbox everything the deployment may do
    expect(boardPolicyProblem(plan(), boardAllow({ "x-board-profile": PROFILE }))).toMatch(/everything the deployment may/);
  });

  it("is not started as another profile, or with none set: the sandbox would name its own", async () => {
    expect(boardPolicyProblem(plan(), boardAllow({ "x-board-profile": "relay-site", "x-board-can": CAN }))).toMatch(/write as relay-site/);
    expect(boardPolicyProblem(plan(), boardAllow({ "x-board-can": CAN }))).toMatch(/any profile it names/);
    expect(boardPolicyProblem(plan(), {})).toMatch(/adds no credential/);
    const f = fake();
    await expect(launch(plan(), secrets({ board: { ...secrets().board, allow: boardAllow({ "x-board-profile": "relay-site", "x-board-can": CAN }) } }), f.create)).rejects.toThrow(/write as relay-site.*not starting it/);
    expect(f.created).toEqual([]);
  });

  it("is another queue for another project's task", () => {
    const other = plan({ task: { id: "790.771", project: "nightfall" } });
    expect(Object.keys(other.board)).toEqual(["work/nightfall", "relay/workers"]);
    expect(boardPolicyProblem(other, boardAllow())).toMatch(/not what the plan says/);
  });
});

describe("the network policy", () => {
  it("allows the plan's hosts and the board's, and no other", () => {
    const policy = cloudNetworkPolicy(plan(), secrets());
    expect(Object.keys(policy.allow).sort()).toEqual(["ai-gateway.vercel.sh", "api.example-cms.com", "api.github.com", "api.vercel.com", "github.com", "registry.npmjs.org"]);
    expect(policy.allow["registry.npmjs.org"]).toEqual([]);
    expect(policy.allow["api.example-cms.com"]).toEqual([]);
    // an object with `allow` is deny-by-default: there is no "*" in it
    expect(Object.keys(policy.allow)).not.toContain("*");
  });

  it("has the firewall add each credential, on the host it is for", () => {
    const policy = cloudNetworkPolicy(plan(), secrets());
    expect(policy.allow["ai-gateway.vercel.sh"]).toEqual([{ match: { path: { startsWith: "/claude-code/" } }, transform: [{ headers: { authorization: `Bearer ${GATEWAY}` } }] }, { response: { statusCode: 403, body: "This sandbox reaches the model gateway's coding endpoint only.", contentType: "text/plain" } }]);
    expect(policy.allow["api.github.com"]).toEqual(githubRules("acme/atlas-site", GITHUB)["api.github.com"]);
    expect(policy.allow["github.com"]).toEqual(githubRules("acme/atlas-site", GITHUB)["github.com"]);
    expect(policy.allow["api.vercel.com"]).toEqual(secrets().board.allow["api.vercel.com"]);
  });

  it("keeps a credentialed host's rules whatever a capability set lists for it", () => {
    const policy = cloudNetworkPolicy(plan({ hosts: ["api.github.com", "github.com", "ai-gateway.vercel.sh", "api.vercel.com"] }), secrets());
    // a set that lists GitHub opens nothing there: the last rule still refuses what the others did not claim
    expect(policy.allow["api.github.com"]).toEqual(githubRules("acme/atlas-site", GITHUB)["api.github.com"]);
    expect(answer(policy.allow["github.com"]!, "POST", "/mallory/drop.git/git-receive-pack")).toEqual(REFUSED);
    expect(policy.allow["ai-gateway.vercel.sh"]).toHaveLength(2);
    // a set that names the board's host does not open the rest of that host: the board's rules stand
    expect(policy.allow["api.vercel.com"]).toEqual(secrets().board.allow["api.vercel.com"]);
  });

  it("refuses a wildcard from a capability set that takes in the board's host", () => {
    expect(() => cloudNetworkPolicy(plan({ hosts: ["*.vercel.com"] }), secrets())).toThrow(/takes in api\.vercel\.com, the board's host/);
    expect(() => cloudNetworkPolicy(plan({ hosts: ["*.vercel.app"] }), secrets())).not.toThrow();
  });

  it("gives the gateway's key to whoever in the sandbox asks for the coding endpoint: the cap is not kept here", () => {
    // no rule can tell relay's Claude Code process from any other in the microVM, so the offer says so (CLOUD_CAP_NOTE)
    const rules = cloudNetworkPolicy(plan(), secrets()).allow["ai-gateway.vercel.sh"]!;
    expect(answer(rules, "POST", "/claude-code/v1/messages")).toEqual({ signed: `Bearer ${GATEWAY}` });
    for (const path of ["/v1/chat/completions", "/v1/messages", "/claude-codex/v1/messages", "/v1/report", "/claude-code"]) expect(answer(rules, "POST", path), path).toEqual(REFUSED);
  });

  it("sends a gateway at the root of its host the key on every path", () => {
    expect(cloudNetworkPolicy(plan({ gatewayUrl: "https://gateway.example.net" }), secrets()).allow["gateway.example.net"]).toEqual([{ transform: [{ headers: { authorization: `Bearer ${GATEWAY}` } }] }]);
  });

  it("knows which header values are credentials", () => {
    const held = credentialsIn(cloudNetworkPolicy(plan(), secrets()));
    for (const secret of [BOARD_JWT, GITHUB, GATEWAY, Buffer.from(`x-access-token:${GITHUB}`).toString("base64")]) expect(held).toContain(secret);
    expect(held).not.toContain(PROFILE);
    expect(held).not.toContain(CAN);
  });
});

describe("the environment", () => {
  it("holds addresses and placeholders under exactly the plan's names, and no credential", () => {
    const env = cloudEnv(plan(), secrets());
    expect(Object.keys(env).sort()).toEqual(plan().env);
    expect(env).toEqual({
      BOARD_URL: "https://api.vercel.com/v1/messageboard/boards/b1",
      BOARD_TOKEN: "placeholder",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      RELAY_BOARD_FROM: "vercel:project:p1:production,vercel:user:u1",
      RELAY_GATEWAY_TOKEN: CLOUD_PLACEHOLDER,
      RELAY_GATEWAY_URL: "https://ai-gateway.vercel.sh/claude-code",
      RELAY_HOME: "/vercel/sandbox/.harness",
    });
    for (const secret of [BOARD_JWT, GITHUB, GATEWAY]) expect(JSON.stringify(env)).not.toContain(secret);
  });

  it("refuses an environment that is not the plan's", () => {
    expect(() => cloudEnv(plan(), secrets({ board: { allow: {}, env: { BOARD_URL: "https://b", BOARD_TOKEN: "placeholder", BOARD_PROFILE: "x" } } }))).toThrow(CloudLaunchError);
    expect(() => cloudEnv(plan(), secrets({ board: { allow: {}, env: { BOARD_URL: "https://b" } } }))).toThrow(/is not the plan's/);
  });
});

describe("launch", () => {
  it("creates one sandbox as the plan says and runs its commands in order, the worker last and detached", async () => {
    const f = fake();
    const p = plan();
    await launch(p, secrets(), f.create);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ name: p.sandbox, image: "vercel/sandbox/universal", resources: { vcpus: 2 }, timeout: 30 * 60_000, persistent: false, tags: { relay: "cloud", worker: p.worker } });
    expect(f.ran.map((c) => c.cmd)).toEqual(["node", "git", "gh", "npm", "sh", "relay"]);
    expect(f.ran.map((c) => !!c.detached)).toEqual([false, false, false, false, false, true]);
    expect(f.ran.at(-1)!.args).toEqual(p.commands.at(-1)!.args);
    expect(f.stopped).toBe(0);
  });

  it("gives the sandbox nothing a credential can be read from", async () => {
    const f = fake();
    await launch(plan(), secrets(), f.create);
    const { networkPolicy, ...readable } = f.created[0]!;
    const inside = JSON.stringify([readable, f.ran]);
    for (const secret of [BOARD_JWT, GITHUB, GATEWAY, Buffer.from(`x-access-token:${GITHUB}`).toString("base64")]) {
      expect(inside).not.toContain(secret);
      expect(JSON.stringify(networkPolicy)).toContain(secret);
    }
    // gh is logged in with a placeholder, read from a variable that one command alone gets
    expect(f.ran.find((c) => c.cmd === "sh")!.env).toEqual({ RELAY_CLOUD_GH_TOKEN: CLOUD_PLACEHOLDER });
    expect(f.ran.filter((c) => c.env)).toHaveLength(1);
  });

  it("does not start when a credential would be readable inside", async () => {
    const f = fake();
    const leaky = secrets({ board: { ...secrets().board, env: { BOARD_URL: "https://api.vercel.com/v1/messageboard/boards/b1", BOARD_TOKEN: BOARD_JWT } } });
    await expect(launch(plan(), leaky, f.create)).rejects.toThrow(/readable inside the sandbox/);
    await expect(launch(plan(), secrets({ from: [`vercel:user:u1`, GATEWAY] }), f.create)).rejects.toThrow(CloudLaunchError);
    expect(f.created).toEqual([]);
  });

  it("stops the sandbox when a tool will not install, and says which, so the start can be tried again", async () => {
    const f = fake({ npm: 1 });
    const e = await refusal(launch(plan(), secrets(), f.create));
    expect(e).toBeInstanceOf(CloudLaunchError);
    expect(e.message).toBe("install: npm exited 1: npm error code ETIMEDOUT npm error network request to https://registry.npmjs.org failed");
    expect(e.uncertain).toBe(false);
    expect(f.ran.map((c) => c.cmd)).toEqual(["node", "git", "gh", "npm"]);
    expect(f.stopped).toBe(1);
  });

  it("stops the sandbox when the worker cannot be started", async () => {
    const f = fake({ relay: new Error("stream closed") });
    const e = await refusal(launch(plan(), secrets(), f.create));
    expect(e).toMatchObject({ message: "stream closed", uncertain: false });
    expect(f.stopped).toBe(1);
  });

  it("says so when a sandbox that failed could not be stopped: something may still run there", async () => {
    const f = fake({ relay: new Error("stream closed") }, { stopFails: true });
    const e = await refusal(launch(plan(), secrets(), f.create));
    expect(e.uncertain).toBe(true);
    expect(e.message).toMatch(/could not be stopped; it ends at its timeout/);
  });

  it("passes on a refusal to create the sandbox", async () => {
    await expect(launch(plan(), secrets(), async () => Promise.reject(new Error("Sandbox quota exceeded")))).rejects.toThrow("Sandbox quota exceeded");
  });
});
