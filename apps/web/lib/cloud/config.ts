/**
 * What this deployment needs before it may offer or start a paid sandbox run, read from the environment:
 *
 *   RELAY_GATEWAY_TOKEN        the model gateway's key. The sandbox's firewall puts it on requests to the gateway;
 *                              inside the sandbox the variable of the same name holds a placeholder.
 *   RELAY_GATEWAY_URL          the gateway Claude Code is pointed at (default: Vercel AI Gateway's Claude Code endpoint)
 *   RELAY_CLOUD_AFTER_MINUTES  how long a task is queued before a run is offered (default 15)
 *   RELAY_CLOUD_MAX_CAP_USD    the most a person may approve for one run (default 10)
 *
 * The board and GitHub need no variable of their own: the sandbox reaches the board as this deployment, and GitHub
 * with an installation token of the site's GitHub App for the one repository.
 */
import { CLOUD_GATEWAY_URL, cloudLimits, type CloudLimits } from "@relay/core";
import cli from "../../../../packages/cli/package.json";
import { dataMode, type Env } from "../mode.ts";

export interface CloudConfig {
  limits: CloudLimits;
  gatewayUrl: string;
  /** The version of relay a sandbox installs: the one this site was built with. */
  relayVersion: string;
}

export function cloudConfig(env: Env = process.env): CloudConfig {
  return { limits: cloudLimits(env), gatewayUrl: env.RELAY_GATEWAY_URL?.trim() || CLOUD_GATEWAY_URL, relayVersion: cli.version };
}

/** Why this deployment cannot run a paid sandbox, in one line, or undefined when it can. The demo offers and starts nothing real, so it has no problem. */
export function cloudProblem(env: Env = process.env): string | undefined {
  if (dataMode(env) !== "db") return undefined;
  if (!env.RELAY_GATEWAY_TOKEN?.trim()) return "Paid sandbox runs are not set up on this deployment: RELAY_GATEWAY_TOKEN, the model gateway's key, is not set.";
  return undefined;
}
