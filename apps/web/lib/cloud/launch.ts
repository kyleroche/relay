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
 * Nothing in this file is called by a test with the real SDK: a start costs money. Tests pass their own `create`.
 */
import { Sandbox, type NetworkPolicy, type NetworkPolicyRule } from "@vercel/sandbox";
import { CLOUD_PLACEHOLDER, CLOUD_RELAY_HOME, type CloudRunPlan } from "@relay/core";

export interface CloudSecrets {
  /** The board's own policy for a sandbox (`board.sandboxPolicy`): its hosts with the credential in their rules, and the environment its client reads. */
  board: { allow: Record<string, NetworkPolicyRule[]>; env: Record<string, string> };
  /** An installation token of the site's GitHub App for the one repository the task works in. */
  github: { repo: string; token: string };
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

/**
 * The network policy of a run: the plan's hosts, plain; the gateway, GitHub and the board with their credential set
 * by the firewall. A host that carries a credential keeps its rules whatever a capability set listed for it.
 */
export function cloudNetworkPolicy(plan: CloudRunPlan, secrets: CloudSecrets): { allow: Record<string, NetworkPolicyRule[]> } {
  const allow: Record<string, NetworkPolicyRule[]> = Object.fromEntries(plan.hosts.map((h) => [h, []]));
  const gateway = new URL(plan.gatewayUrl);
  const bearer: NetworkPolicyRule = { transform: [{ headers: { authorization: `Bearer ${secrets.gateway}` } }] };
  const under = gateway.pathname.replace(/\/+$/, "");
  // the key is for the endpoint the lane is pointed at; anything else on that host is answered by the firewall
  allow[gateway.hostname] = under ? [{ ...bearer, match: { path: { startsWith: `${under}/` } } }, { response: { statusCode: 403, body: "This sandbox reaches the model gateway's coding endpoint only.", contentType: "text/plain" } }] : [bearer];
  allow["api.github.com"] = [{ transform: [{ headers: { authorization: `Bearer ${secrets.github.token}` } }] }];
  // git over https: the token as the password of x-access-token, on this repository's paths only
  allow["github.com"] = [{ match: { path: { regex: `^/${reEscape(secrets.github.repo)}(\\.git)?/.*$` } }, transform: [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${secrets.github.token}`).toString("base64")}` } }] }];
  return { allow: { ...allow, ...secrets.board.allow } };
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
