/**
 * Exactly what a paid sandbox run creates: the image, the hosts its network policy allows, the names of the
 * environment variables it holds, the commands, the timeout. Pure, with no SDK call in it, so the whole run can be
 * read (and tested) before anything exists; the site turns a plan into calls (apps/web/lib/cloud/launch.ts).
 *
 * No credential is an input here, so none can be in a plan. The three a run needs (the board, GitHub for one
 * repository, the model gateway) are added to its requests by the sandbox's firewall; inside, the variables that name
 * them hold a placeholder.
 */
import { taskRef, workerProfile } from "../board/mapping.ts";
import type { BoardTask } from "../board/tasks.ts";
import { CLOUD_LANE } from "./offer.ts";

export const CLOUD_PACKAGE = "@kyleroche/relay";
/** Vercel's own image: Node 24, git and the GitHub CLI are in it, which the plan's first commands check. */
export const CLOUD_IMAGE = "vercel/sandbox/universal";
export const CLOUD_VCPUS = 2;
/** Claude Code's endpoint on Vercel AI Gateway. */
export const CLOUD_GATEWAY_URL = "https://ai-gateway.vercel.sh/claude-code";
/** What a variable holds inside the sandbox where a credential would be: the firewall puts the real one on the request. */
export const CLOUD_PLACEHOLDER = "relay-placeholder";
/** relay's home inside the sandbox, on the path the image keeps writable. */
export const CLOUD_RELAY_HOME = "/vercel/sandbox/.harness";
/** The variable the placeholder for `gh auth login --with-token` is read from, on that one command. */
export const CLOUD_GH_VARIABLE = "RELAY_CLOUD_GH_TOKEN";
export const CLOUD_GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
export const CLOUD_NPM_HOSTS = ["registry.npmjs.org"] as const;
/**
 * What the sandbox may do on the board, at most: claim, report on and hold tasks in the queues, and keep its own
 * message among the workers. The board narrows the deployment's own rights to this (`x-board-can`).
 */
export const CLOUD_BOARD_CAN: Record<string, Array<"read" | "post" | "react" | "label">> = { "work/": ["read", "post", "react", "label"], "relay/workers": ["read", "post", "label"] };

const MIN = 60_000;
export const CLOUD_MAX_TIMEOUT_MS = 60 * MIN;
export const CLOUD_MIN_TIMEOUT_MS = 15 * MIN;
/** What installing the tools and cloning take, before and after the lane's own time. */
export const CLOUD_SETUP_MS = 5 * MIN;
/** A run ends this long before the shortest-lived credential at the firewall does. */
export const CLOUD_CREDENTIAL_MARGIN_MS = 2 * MIN;

/**
 * How long a sandbox may live for a cap: ten minutes to set up and push, ten more per dollar, never under a quarter
 * of an hour and never over an hour. The cap stops the spend; this stops a run that hangs without spending.
 */
export function cloudTimeoutMs(capUsd: number): number {
  const sized = (10 + 10 * (Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 0)) * MIN;
  return Math.round(Math.min(CLOUD_MAX_TIMEOUT_MS, Math.max(CLOUD_MIN_TIMEOUT_MS, sized)));
}

/** Thrown for a run that cannot be planned as asked; the message is for the task's thread. */
export class CloudPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudPlanError";
  }
}

export interface CloudNames {
  /** The worker inside: `cloud-<ref of the task>`. */
  worker: string;
  /** The profile it writes as on the board, which the board's policy sets on every request. */
  profile: string;
  /** The sandbox: one name per start, so a second start of the same one is refused by the platform. */
  sandbox: string;
}

/** The names of one start of a task's run. `start` is the grant it runs under and which try this is. */
export function cloudNames(taskId: string, start: { grant: string; n: number } = { grant: "", n: 1 }): CloudNames {
  const ref = taskRef(taskId);
  const worker = `cloud-${ref}`;
  return { worker, profile: workerProfile(worker, CLOUD_LANE), sandbox: `relay-cloud-${ref}-${taskRef(`${start.grant}:${start.n}`).slice(0, 6)}` };
}

export interface CloudCommand {
  /** What the command is for, in the failure a person reads. */
  step: "node" | "git" | "gh" | "install" | "github" | "work";
  cmd: string;
  args: string[];
  /** Names of variables this command alone gets. */
  env?: string[];
  /** Started and left running: the launcher does not wait for it. */
  detached?: true;
}

export interface CloudRunPlan extends CloudNames {
  task: string;
  capUsd: number;
  image: string;
  vcpus: number;
  timeoutMs: number;
  /** The model gateway, as the worker inside is pointed at it. */
  gatewayUrl: string;
  /**
   * Every host the network policy allows besides the board's own, which the board's policy names: the gateway,
   * GitHub, the npm registry and the hosts of the capability sets granted to this task. Any other host is blocked.
   */
  hosts: string[];
  /** What the sandbox may do on the board, at most (`CLOUD_BOARD_CAN`). */
  board: Record<string, string[]>;
  /** The names of the environment variables the sandbox holds. None of them holds a credential. */
  env: string[];
  /** In order. Each but the last must exit 0 before the next runs. */
  commands: CloudCommand[];
}

export interface CloudRunInput {
  task: Pick<BoardTask, "id">;
  /** The most the run may spend, in US dollars: the trusted grant's. */
  cap: number;
  /** The published version of relay to install, exactly. */
  relayVersion: string;
  /** The hosts of the capability sets granted to this task. */
  hosts: readonly string[];
  /** The model gateway's URL (https), when it is not Vercel AI Gateway's. */
  gatewayUrl?: string;
  /** The grant this start runs under and which try it is. */
  start?: { grant: string; n: number };
  /** How long the shortest-lived credential at the firewall is still good for. A run never outlives it. */
  credentialLifeMs?: number;
}

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function cloudRunPlan(i: CloudRunInput): CloudRunPlan {
  if (!(Number.isFinite(i.cap) && i.cap > 0)) throw new CloudPlanError("a paid run needs a cap above $0.");
  // it becomes part of an npm argument; only an exact version is ever installed
  if (!VERSION.test(i.relayVersion)) throw new CloudPlanError(`'${i.relayVersion}' is not an exact version of ${CLOUD_PACKAGE}.`);
  const bad = i.hosts.find((h) => !HOST.test(h));
  if (bad !== undefined) throw new CloudPlanError(`'${bad}' is not a host name.`);
  let gateway: URL;
  try {
    gateway = new URL(i.gatewayUrl ?? CLOUD_GATEWAY_URL);
  } catch {
    throw new CloudPlanError("the model gateway's URL (RELAY_GATEWAY_URL) is not a URL.");
  }
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.search || gateway.hash) throw new CloudPlanError("the model gateway's URL (RELAY_GATEWAY_URL) must be https, with no credentials, query or fragment.");

  let timeoutMs = cloudTimeoutMs(i.cap);
  if (i.credentialLifeMs !== undefined) {
    timeoutMs = Math.min(timeoutMs, Math.floor(i.credentialLifeMs - CLOUD_CREDENTIAL_MARGIN_MS));
    if (timeoutMs < CLOUD_MIN_TIMEOUT_MS) throw new CloudPlanError(`the credentials the sandbox's firewall would hold are good for ${Math.max(0, Math.floor(i.credentialLifeMs / MIN))} more minutes, too few for a run.`);
  }
  const names = cloudNames(i.task.id, i.start);
  const minutes = Math.max(5, Math.floor((timeoutMs - CLOUD_SETUP_MS) / MIN));
  const cap = i.cap.toFixed(2);
  return {
    ...names,
    task: i.task.id,
    capUsd: Number(cap),
    image: CLOUD_IMAGE,
    vcpus: CLOUD_VCPUS,
    timeoutMs,
    gatewayUrl: gateway.href.replace(/\/$/, ""),
    hosts: [...new Set([gateway.hostname, ...CLOUD_GITHUB_HOSTS, ...CLOUD_NPM_HOSTS, ...i.hosts])].sort(),
    board: Object.fromEntries(Object.entries(CLOUD_BOARD_CAN).map(([channel, can]) => [channel, [...can]])),
    env: ["BOARD_TOKEN", "BOARD_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "RELAY_BOARD_FROM", "RELAY_GATEWAY_TOKEN", "RELAY_GATEWAY_URL", "RELAY_HOME"],
    commands: [
      // the image is Vercel's to change: a missing tool ends the start here, before anything can spend
      { step: "node", cmd: "node", args: ["-e", "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"] },
      { step: "git", cmd: "git", args: ["--version"] },
      { step: "gh", cmd: "gh", args: ["--version"] },
      { step: "install", cmd: "npm", args: ["install", "-g", "--no-fund", "--no-audit", `${CLOUD_PACKAGE}@${i.relayVersion}`, "@anthropic-ai/claude-code"] },
      // gh and git then send the placeholder, and the firewall replaces it on the way to GitHub
      { step: "github", cmd: "sh", args: ["-c", `printf %s "$${CLOUD_GH_VARIABLE}" | gh auth login --hostname github.com --with-token && gh auth setup-git`], env: [CLOUD_GH_VARIABLE] },
      // --no-sandbox is right here and nowhere else: the microVM is the isolation
      { step: "work", cmd: "relay", args: ["work", "--task", i.task.id, "--billing", "gateway", "--cap", cap, "--no-sandbox", "--name", names.worker, "--max-minutes", String(minutes)], detached: true },
    ],
  };
}
