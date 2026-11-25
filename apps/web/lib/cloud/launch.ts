/**
 * A plan (core's `cloudRunPlan`) turned into calls on `@vercel/sandbox`: one microVM, its network policy, its
 * environment, the plan's commands in order. Thin on purpose: every decision is in the plan, which is pure and
 * tested; this file only adds the three credentials, and only where the sandbox cannot read them.
 *
 * The credentials are in the network policy and nowhere else. The sandbox's firewall sets the header on requests to
 * the board, to GitHub and to the model gateway (`transform`, network-policy.d.ts of the SDK); the environment inside
 * holds a placeholder under each name a tool looks for, so nothing that runs there can read a credential or take it
 * to another host. Every host the policy does not name is blocked.
 *
 * Not readable is not the same as not usable. The lane runs without Claude Code's OS sandbox in there, so code a
 * fooled lane runs can send any request these rules sign. The rules are therefore the list of what such code can do,
 * and each is as narrow as the run needs:
 *
 *   GitHub    a token for the one repository with the plan's permissions, on that repository's three git endpoints
 *             and, on the API, on `GET /`, `POST /graphql` and reads under `/repos/<repo>`. Every other request to
 *             either host is answered 403 here, the REST merge, ref and branch-protection paths by name.
 *   the board the deployment's credential, held to the plan's `board` and to the worker's profile; a policy that
 *             says otherwise is not started.
 *   gateway   the site's one key, on the coding endpoint, for any process that asks (the cap is relay's own count).
 *
 * What the rules cannot do: `gh` opens and comments on pull requests through `/graphql`, and a rule sees a path,
 * not a body, so a merge sent as a GraphQL mutation gets the token like any other. And a push is a push: the
 * firewall cannot tell `HEAD:main` from the run's own branch. Only the repository's own branch rules stop those,
 * which is why a run is not approved or started without them (lib/cloud/guard.ts).
 *
 * Nothing in this file is called by a test with the real SDK: a start costs money. Tests pass their own `create`.
 * Experimental: no rule here has been tried against the real firewall.
 */
import { Sandbox, type NetworkPolicy, type NetworkPolicyRule } from "@vercel/sandbox";
import { CLOUD_PLACEHOLDER, CLOUD_RELAY_HOME, cloudHostCovers, type CloudRunPlan } from "@relay/core";

export interface CloudSecrets {
  /** The board's own policy for a sandbox (`board.sandboxPolicy`): its hosts with the credential in their rules, and the environment its client reads. */
  board: { allow: Record<string, NetworkPolicyRule[]>; env: Record<string, string> };
  /**
   * An installation token of the site's GitHub App for the one repository the task works in, and what GitHub said
   * it may do when it minted it. A token that may do more than the plan's `githubPermissions` is not used.
   */
  github: { repo: string; token: string; permissions: Record<string, string> };
  /** The model gateway's key. */
  gateway: string;
  /** The owners whose tasks the worker inside takes, and whose words it believes: the site's own list. */
  from: readonly string[];
}

/** The part of a sandbox this file uses. */
export interface CloudSandbox {
  runCommand(params: { cmd: string; args: string[]; env?: Record<string, string>; detached?: boolean }): Promise<{ exitCode: number | null; stderr(): Promise<string> }>;
  stop(): Promise<unknown>;
}

/** What a sandbox is created with: the plan's, with the network policy and the environment made from it. A type, not an interface, so it is the SDK's own parameter. */
export type CloudSandboxParams = {
  name: string;
  image: string;
  resources: { vcpus: number };
  timeout: number;
  networkPolicy: NetworkPolicy;
  env: Record<string, string>;
  persistent: false;
  tags: Record<string, string>;
};

export type CreateSandbox = (params: CloudSandboxParams) => Promise<CloudSandbox>;

/** `uncertain` when the sandbox could not be stopped after a failure: something may still run there, so the start is not tried again. */
export class CloudLaunchError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "CloudLaunchError";
  }
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refuse = (body: string): NetworkPolicyRule => ({ response: { statusCode: 403, body, contentType: "text/plain" } });

/** Any repository's REST paths, by name or by ID: GitHub answers both, and neither is case sensitive. */
const ANY_REPO = "/(repos/[^/]+/[^/]+|repositories/[^/]+)";
/**
 * What a paid run is refused on GitHub's REST API by name, before any rule that adds the token is looked at. The
 * rules after them would refuse these anyway (they sign reads only); these say why, and stay in the way if a later
 * change signs more. Each is a decision a person makes, or a way around one.
 */
export const GITHUB_REFUSED: ReadonlyArray<{ what: string; regex: string; method?: string[] }> = [
  { what: "merge a pull request", regex: `^(?i:${ANY_REPO}/pulls/[^/]+/merge/?)$` },
  { what: "merge a branch", regex: `^(?i:${ANY_REPO}/merges/?)$` },
  { what: "create, move or delete a branch or tag through the API", regex: `^(?i:${ANY_REPO}/git/refs(/.*)?)$`, method: ["POST", "PATCH", "PUT", "DELETE"] },
  { what: "read or change branch protection", regex: `^(?i:${ANY_REPO}/branches/.+/protection(/.*)?)$` },
  { what: "read or change rulesets", regex: `^(?i:${ANY_REPO}/(rulesets|rules)(/.*)?)$` },
];

/**
 * GitHub for one repository, as `git` and `gh` use it in a job (`ghHost` in packages/core/src/work/job.ts):
 *
 *   github.com       the three endpoints of git over https for `<repo>` (`info/refs`, `git-upload-pack`,
 *                    `git-receive-pack`), with the token as the password of x-access-token. Nothing else on the
 *                    host, so no other repository, public or not, and no place to carry the clone to.
 *   api.github.com   `GET /`, where `gh auth login` reads a token's scopes; `POST /graphql`, which is how `gh`
 *                    looks up the repository and the pull request, opens it and comments on it; and reads under
 *                    `/repos/<repo>`. No REST write at all: `gh` makes none in a job.
 *
 * The paths are matched as written, in the repository's own spelling: another spelling of the same repository is
 * another path, and is refused.
 */
export function githubRules(repo: string, token: string): { "api.github.com": NetworkPolicyRule[]; "github.com": NetworkPolicyRule[] } {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((part) => /^\.+$/.test(part))) throw new CloudLaunchError(`'${repo}' is not a repository (owner/name), so there is no path to hold the sandbox to`);
  const at = reEscape(repo);
  const bearer = [{ headers: { authorization: `Bearer ${token}` } }];
  // git over https: the token as the password of x-access-token
  const basic = [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } }];
  return {
    "api.github.com": [
      ...GITHUB_REFUSED.map((r) => ({ match: { path: { regex: r.regex }, ...(r.method ? { method: r.method } : {}) }, ...refuse(`A paid run does not ${r.what}.`) })),
      { match: { method: ["GET"], path: { exact: "/" } }, transform: bearer },
      // a mutation is a body, and a rule sees none: a merge sent here gets the token (see the top of this file)
      { match: { method: ["POST"], path: { exact: "/graphql" } }, transform: bearer },
      { match: { method: ["GET", "HEAD"], path: { regex: `^/repos/${at}(/.*)?$` } }, transform: bearer },
      refuse(`This sandbox reads ${repo} on GitHub's API and calls /graphql; nothing else.`),
    ],
    "github.com": [
      { match: { method: ["GET"], path: { regex: `^/${at}(\\.git)?/info/refs$` } }, transform: basic },
      { match: { method: ["POST"], path: { regex: `^/${at}(\\.git)?/git-(upload|receive)-pack$` } }, transform: basic },
      refuse(`This sandbox reaches ${repo} on github.com over git; nothing else.`),
    ],
  };
}

/** `dev/=read,post;ci/=read` as the board writes `x-board-can`; undefined for anything else, `all` included. */
function parseCan(header: string): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const entry of header.split(";")) {
    const m = /^([^=;]+)=([a-z]+(?:,[a-z]+)*)$/.exec(entry.trim());
    if (!m || m[2] === "all" || m[1]! in out) return undefined;
    out[m[1]!.trim()] = m[2]!.split(",").sort();
  }
  return out;
}
const sameCan = (a: Record<string, readonly string[]>, b: Record<string, readonly string[]>): boolean => {
  const flat = (c: Record<string, readonly string[]>): string => Object.keys(c).sort().map((k) => `${k}=${[...c[k]!].sort().join(",")}`).join(";");
  return flat(a) === flat(b);
};

/**
 * Why the board's policy is not the plan's, or undefined when it is: every rule that carries the board's credential
 * must also say who the sandbox writes as (the plan's profile) and what it may do at most (the plan's `board`). A
 * rule that added the credential alone would let the sandbox name its own profile, or act wherever the deployment
 * may.
 */
export function boardPolicyProblem(plan: Pick<CloudRunPlan, "profile" | "board">, allow: CloudSecrets["board"]["allow"]): string | undefined {
  const signing = Object.values(allow).flatMap((rules) => rules.flatMap((r) => (r.transform ?? []).map((t) => t.headers ?? {}))).filter((h) => Object.keys(h).some((name) => name.toLowerCase() === "authorization"));
  if (signing.length === 0) return "the board's policy adds no credential, so the sandbox could not reach the board";
  for (const headers of signing) {
    const get = (name: string): string | undefined => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
    if (get("x-board-profile") !== plan.profile) return `the board's policy would have the sandbox write as ${get("x-board-profile") ?? "any profile it names"}, not ${plan.profile}`;
    const can = parseCan(get("x-board-can") ?? "");
    if (!can || !sameCan(can, plan.board)) return `the board's policy would let the sandbox do '${get("x-board-can") ?? "everything the deployment may"}', not what the plan says (${Object.keys(plan.board).join(", ")})`;
  }
  return undefined;
}

/** Why the GitHub token may do more than the plan says, or undefined when it may not. */
export function githubTokenProblem(plan: Pick<CloudRunPlan, "githubPermissions">, granted: Record<string, string>): string | undefined {
  const more = Object.entries(granted).filter(([name, level]) => !(plan.githubPermissions[name] === level || (plan.githubPermissions[name] === "write" && level === "read")));
  return more.length ? `GitHub's token may do more than a run needs (${more.map(([name, level]) => `${name}: ${level}`).join(", ")})` : undefined;
}

/**
 * The network policy of a run: the plan's hosts, plain; the gateway, GitHub and the board with their credential set
 * by the firewall. A host that carries a credential keeps its rules whatever a capability set listed for it.
 */
export function cloudNetworkPolicy(plan: CloudRunPlan, secrets: CloudSecrets): { allow: Record<string, NetworkPolicyRule[]> } {
  const allow: Record<string, NetworkPolicyRule[]> = Object.fromEntries(plan.hosts.map((h) => [h, []]));
  const gateway = new URL(plan.gatewayUrl);
  const bearer: NetworkPolicyRule = { transform: [{ headers: { authorization: `Bearer ${secrets.gateway}` } }] };
  const under = gateway.pathname.replace(/\/+$/, "");
  // the key is for the endpoint the lane is pointed at; anything else on that host is answered by the firewall.
  // Any process in the sandbox that asks for that endpoint gets the key: the cap is not kept here
  allow[gateway.hostname] = under ? [{ ...bearer, match: { path: { startsWith: `${under}/` } } }, refuse("This sandbox reaches the model gateway's coding endpoint only.")] : [bearer];
  // the plan refuses a wildcard over the gateway or GitHub; the board's hosts are known only here
  for (const signed of Object.keys(secrets.board.allow)) {
    const wide = plan.hosts.find((h) => cloudHostCovers(h, signed));
    if (wide !== undefined) throw new CloudLaunchError(`a capability set allows '${wide}', which takes in ${signed}, the board's host, which carries a credential`);
  }
  return { allow: { ...allow, ...githubRules(secrets.github.repo, secrets.github.token), ...secrets.board.allow } };
}

/** The environment inside: addresses and placeholders. Exactly the names the plan lists. */
export function cloudEnv(plan: CloudRunPlan, secrets: CloudSecrets): Record<string, string> {
  const env: Record<string, string> = {
    ...secrets.board.env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    RELAY_BOARD_FROM: secrets.from.join(","),
    RELAY_GATEWAY_TOKEN: CLOUD_PLACEHOLDER,
    RELAY_GATEWAY_URL: plan.gatewayUrl,
    RELAY_HOME: CLOUD_RELAY_HOME,
  };
  const names = Object.keys(env).sort();
  if (names.join() !== [...plan.env].sort().join()) throw new CloudLaunchError(`the sandbox's environment (${names.join(", ")}) is not the plan's (${plan.env.join(", ")})`);
  return env;
}

/**
 * Every credential a policy carries: the values of the headers its rules set that authenticate a request. A header
 * that only says who the sandbox is or what it may do (the board's profile and `can`) is no secret.
 */
export function credentialsIn(policy: { allow: Record<string, NetworkPolicyRule[]> }): string[] {
  const headers = Object.values(policy.allow).flatMap((rules) => rules.flatMap((r) => (r.transform ?? []).flatMap((t) => Object.entries(t.headers ?? {}))));
  const values = headers.filter(([name]) => /authorization|cookie|secret|token|key|bypass/i.test(name)).map(([, value]) => value);
  // the header's value, and the credential in it without its scheme
  return [...new Set(values.flatMap((v) => [v, v.replace(/^(Bearer|Basic|token)\s+/i, "")]))].filter((v) => v.length >= 8);
}

/**
 * Start the plan's sandbox and its worker. Resolves once the worker is running; the sandbox ends itself at the plan's
 * timeout. A command that fails before that stops the sandbox and throws, so the start can be tried again.
 */
export async function launch(plan: CloudRunPlan, secrets: CloudSecrets, create: CreateSandbox = (params) => Sandbox.create(params)): Promise<void> {
  const networkPolicy = cloudNetworkPolicy(plan, secrets);
  const env = cloudEnv(plan, secrets);
  // the last check before anything exists: no credential in what the sandbox can read
  const held = credentialsIn(networkPolicy);
  const readable = [...Object.values(env), ...plan.commands.flatMap((c) => [c.cmd, ...c.args])];
  if (readable.some((v) => held.some((secret) => v.includes(secret)))) throw new CloudLaunchError("a credential would be readable inside the sandbox; not starting it.");
  // and none that can be used for more than the plan says
  const wider = githubTokenProblem(plan, secrets.github.permissions) ?? boardPolicyProblem(plan, secrets.board.allow);
  if (wider) throw new CloudLaunchError(`${wider}; not starting it.`);

  const sandbox = await create({ name: plan.sandbox, image: plan.image, resources: { vcpus: plan.vcpus }, timeout: plan.timeoutMs, networkPolicy, env, persistent: false, tags: { relay: "cloud", worker: plan.worker } });
  try {
    for (const c of plan.commands) {
      const own = c.env ? { env: Object.fromEntries(c.env.map((name) => [name, CLOUD_PLACEHOLDER])) } : {};
      if (c.detached) {
        await sandbox.runCommand({ cmd: c.cmd, args: c.args, ...own, detached: true });
        continue;
      }
      const done = await sandbox.runCommand({ cmd: c.cmd, args: c.args, ...own });
      if (done.exitCode !== 0) {
        const said = (await done.stderr().catch(() => "")).trim().split("\n").slice(-3).join(" ");
        throw new CloudLaunchError(`${c.step}: ${c.cmd} exited ${done.exitCode}${said ? `: ${said}` : ""}`);
      }
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const stopped = await sandbox.stop().then(
      () => true,
      () => false,
    );
    throw new CloudLaunchError(stopped ? why : `${why} (and the sandbox ${plan.sandbox} could not be stopped; it ends at its timeout)`, !stopped);
  }
}
