/**
 * A plan turned into sandbox calls (lib/cloud/launch.ts), against a sandbox that only remembers what it was asked:
 * no test creates a real one. What matters here is where the three credentials are (the firewall's rules) and where
 * they are not (anything the sandbox can read).
 */
import { describe, expect, it } from "vitest";
import { CLOUD_PLACEHOLDER, cloudRunPlan, type CloudRunPlan } from "@relay/core";
import { cloudEnv, CloudLaunchError, cloudNetworkPolicy, credentialsIn, launch, type CloudSandbox, type CloudSandboxParams, type CloudSecrets } from "../lib/cloud/launch.ts";

const BOARD_JWT = "fake-header.fake-board-oidc-token-of-the-deployment.fake-signature";
const GITHUB = "fake-github-installation-token-for-one-repository";
const GATEWAY = "fake-model-gateway-key-of-the-owner";

const plan = (over: Partial<Parameters<typeof cloudRunPlan>[0]> = {}): CloudRunPlan => cloudRunPlan({ task: { id: "790.771" }, cap: 2, relayVersion: "0.3.2", hosts: ["api.example-cms.com"], start: { grant: "790.800", n: 1 }, ...over });

const secrets = (over: Partial<CloudSecrets> = {}): CloudSecrets => ({
  board: {
    allow: {
      "api.vercel.com": [
        { match: { method: ["GET"], path: { startsWith: "/v1/messageboard/boards/b1/" } }, transform: [{ headers: { authorization: `Bearer ${BOARD_JWT}`, "x-board-profile": "relay-cloud-0a1b2c3d-claude", "x-board-can": "work/=read,post,react,label" } }] },
        { response: { statusCode: 403 } },
      ],
    },
    env: { BOARD_URL: "https://api.vercel.com/v1/messageboard/boards/b1", BOARD_TOKEN: "placeholder" },
  },
  github: { repo: "acme/atlas-site", token: GITHUB },
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
    expect(policy.allow["api.github.com"]).toEqual([{ transform: [{ headers: { authorization: `Bearer ${GITHUB}` } }] }]);
    const git = policy.allow["github.com"]![0]!;
    expect(git.transform).toEqual([{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${GITHUB}`).toString("base64")}` } }]);
    expect(policy.allow["api.vercel.com"]).toEqual(secrets().board.allow["api.vercel.com"]);
  });

  it("puts the GitHub credential on the one repository's git paths only", () => {
    const rule = cloudNetworkPolicy(plan(), secrets({ github: { repo: "acme/atlas.site", token: GITHUB } })).allow["github.com"]![0]!;
    const path = new RegExp((rule.match!.path as { regex: string }).regex);
    for (const p of ["/acme/atlas.site.git/info/refs", "/acme/atlas.site/info/refs", "/acme/atlas.site.git/git-receive-pack"]) expect(path.test(p), p).toBe(true);
    for (const p of ["/acme/atlas-site.git/info/refs", "/acme/atlasXsite/info/refs", "/acme/atlas.site-fork/info/refs", "/other/atlas.site.git/info/refs", "/acme/atlas.site", "/x/acme/atlas.site/info/refs"]) expect(path.test(p), p).toBe(false);
  });

  it("keeps a credentialed host's rules whatever a capability set lists for it", () => {
    const policy = cloudNetworkPolicy(plan({ hosts: ["api.github.com", "ai-gateway.vercel.sh", "api.vercel.com"] }), secrets());
    expect(policy.allow["api.github.com"]).toHaveLength(1);
    expect(policy.allow["ai-gateway.vercel.sh"]).toHaveLength(2);
    // a set that names the board's host does not open the rest of that host: the board's rules stand
    expect(policy.allow["api.vercel.com"]).toEqual(secrets().board.allow["api.vercel.com"]);
  });

  it("sends a gateway at the root of its host the key on every path", () => {
    expect(cloudNetworkPolicy(plan({ gatewayUrl: "https://gateway.example.net" }), secrets()).allow["gateway.example.net"]).toEqual([{ transform: [{ headers: { authorization: `Bearer ${GATEWAY}` } }] }]);
  });

  it("knows which header values are credentials", () => {
    const held = credentialsIn(cloudNetworkPolicy(plan(), secrets()));
    for (const secret of [BOARD_JWT, GITHUB, GATEWAY, Buffer.from(`x-access-token:${GITHUB}`).toString("base64")]) expect(held).toContain(secret);
    expect(held).not.toContain("relay-cloud-0a1b2c3d-claude");
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
