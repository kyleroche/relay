/**
 * Exactly what a paid sandbox run creates: the image, the hosts its network policy allows, the names of the
 * environment variables it holds, the commands, the timeout. Pure, with no SDK call in it, so the whole run can be
 * read (and tested) before anything exists; the site turns a plan into calls (apps/web/lib/cloud/launch.ts).
 *
 * No credential is an input here, so none can be in a plan. The three a run needs (the board, GitHub for one
 * repository, the model gateway) are added to its requests by the sandbox's firewall; inside, the variables that name
 * them hold a placeholder.
 *
 * That keeps a credential from being read. It does not keep it from being used: the lane runs with `--no-sandbox`
 * inside the microVM, so code a fooled lane runs there can send any request the firewall would sign. What a plan
 * says about the board (`board`) and GitHub (`githubPermissions`) is therefore the most such code can do, and both
 * are as narrow as one run of one task needs (docs/SECURITY.md, "What a paid run's lane can reach").
 *
 * Experimental: nothing here has been run against a real sandbox.
 */
import { taskRef, WORKERS_CHANNEL, workChannel, workerProfile } from "../board/mapping.ts";
import type { BoardTask } from "../board/tasks.ts";
import { CLOUD_LANE } from "./offer.ts";

export const CLOUD_PACKAGE = "@kyleroche/relay";
export const CLOUD_CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
/**
 * The one version of Claude Code a sandbox installs: `npm view @anthropic-ai/claude-code version` on 2026-11-24.
 * Bump it deliberately, in a change of its own, after reading what changed: the sandbox runs whatever this names
 * with the gateway's key at its firewall, and an unpinned install would run whatever was published last.
 */
export const CLOUD_CLAUDE_CODE_VERSION = "2.1.331";
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
export type CloudBoardPermission = "read" | "post" | "react" | "label";
/**
 * What the sandbox may do on the board, at most: claim, report on and hold tasks in its own project's queue, and
 * keep its own message among the workers. The board narrows the deployment's own rights to this (`x-board-can`),
 * so no other project's queue is in reach. Inside that queue it is still a worker like any other: it can post in,
 * label and claim every task there, not only its own.
 */
export function cloudBoardCan(project: string): Record<string, CloudBoardPermission[]> {
  return { [workChannel(project)]: ["read", "post", "react", "label"], [WORKERS_CHANNEL]: ["read", "post", "label"] };
}
/**
 * The permissions of the GitHub installation token at the firewall, of everything the site's App was granted: push a
 * branch (`contents`), open and comment on a pull request (`pull_requests`), and `metadata`, which every token has.
 * Not issues, Actions, deployments or anything else the App holds. `contents: write` is also what merging and
 * deleting a branch take on GitHub, so this alone does not stop either (apps/web/lib/cloud/guard.ts does that part).
 */
export const CLOUD_GITHUB_PERMISSIONS = { contents: "write", metadata: "read", pull_requests: "write" } as const;

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
  /** What the sandbox may do on the board, at most (`cloudBoardCan`): its project's queue and the workers channel. */
  board: Record<string, string[]>;
  /** The permissions the GitHub token at the firewall is minted with (`CLOUD_GITHUB_PERMISSIONS`). */
  githubPermissions: Record<string, "read" | "write">;
  /** The names of the environment variables the sandbox holds. None of them holds a credential. */
  env: string[];
  /** In order. Each but the last must exit 0 before the next runs. */
  commands: CloudCommand[];
}

export interface CloudRunInput {
  /** The task, and the project whose queue it is in: the only queue the sandbox may touch. */
  task: Pick<BoardTask, "id" | "project">;
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

/**
 * Whether a wildcard a capability set lists (`*.example.com`) takes in a host: one under it, or the name itself.
 * A wildcard over a host that carries a credential is refused rather than left to the firewall's precedence
 * between a wildcard and a name: nobody should have to know which of the two rule lists a request to GitHub gets.
 */
export function cloudHostCovers(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") && (host === pattern.slice(2) || host.endsWith(pattern.slice(1)));
}
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
  for (const signed of [gateway.hostname, ...CLOUD_GITHUB_HOSTS]) {
    const wide = i.hosts.find((h) => cloudHostCovers(h, signed));
    if (wide !== undefined) throw new CloudPlanError(`a capability set allows '${wide}', which takes in ${signed}, a host the sandbox's firewall adds a credential for. Name the hosts the set needs instead.`);
  }

  let timeoutMs = cloudTimeoutMs(i.cap);
  if (i.credentialLifeMs !== undefined) {
    timeoutMs = Math.min(timeoutMs, Math.floor(i.credentialLifeMs - CLOUD_CREDENTIAL_MARGIN_MS));
    if (timeoutMs < CLOUD_MIN_TIMEOUT_MS) throw new CloudPlanError(`the credentials the sandbox's firewall would hold are good for ${Math.max(0, Math.floor(i.credentialLifeMs / MIN))} more minutes, too few for a run.`);
  }
  if (!i.task.project) throw new CloudPlanError("the task is in no project's queue, so there is no queue to hold the sandbox to.");
  let boardCan: Record<string, CloudBoardPermission[]>;
  try {
    boardCan = cloudBoardCan(i.task.project);
  } catch (e) {
    throw new CloudPlanError(e instanceof Error ? e.message : String(e));
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
    board: boardCan,
    githubPermissions: { ...CLOUD_GITHUB_PERMISSIONS },
    env: ["BOARD_TOKEN", "BOARD_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "RELAY_BOARD_FROM", "RELAY_GATEWAY_TOKEN", "RELAY_GATEWAY_URL", "RELAY_HOME"],
    commands: [
      // the image is Vercel's to change: a missing tool ends the start here, before anything can spend
      { step: "node", cmd: "node", args: ["-e", "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"] },
      { step: "git", cmd: "git", args: ["--version"] },
      { step: "gh", cmd: "gh", args: ["--version"] },
      { step: "install", cmd: "npm", args: ["install", "-g", "--no-fund", "--no-audit", `${CLOUD_PACKAGE}@${i.relayVersion}`, `${CLOUD_CLAUDE_CODE_PACKAGE}@${CLOUD_CLAUDE_CODE_VERSION}`] },
      // gh and git then send the placeholder, and the firewall replaces it on the way to GitHub
      { step: "github", cmd: "sh", args: ["-c", `printf %s "$${CLOUD_GH_VARIABLE}" | gh auth login --hostname github.com --with-token && gh auth setup-git`], env: [CLOUD_GH_VARIABLE] },
      // --no-sandbox is right here and nowhere else: the microVM is the isolation
      { step: "work", cmd: "relay", args: ["work", "--task", i.task.id, "--billing", "gateway", "--cap", cap, "--no-sandbox", "--name", names.worker, "--max-minutes", String(minutes)], detached: true },
    ],
  };
}
