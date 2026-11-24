/** The environment a job and its children run with (docs/SECURITY.md, "Workers"). */

/** Variables no child of a job may inherit: API keys and CI tokens (the lane runs on the subscription; gh acts as the operator), and every credential the worker itself reaches the board or relay with. */
export const JOB_ENV_STRIPPED = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "XAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "RELAY_TOKEN", "RELAY_SITE", "RELAY_HOME", "BOARD_TOKEN", "BOARD_URL", "BOARD_PROFILE", "VERCEL_TOKEN", "VERCEL_AUTH_TOKEN", "VERCEL_OIDC_TOKEN", "RELAY_GATEWAY_URL", "RELAY_GATEWAY_TOKEN"] as const;

/**
 * The environment a job runs with. No API key or CI token may shadow the machine's logins (the lane runs on the
 * subscription; gh acts as the operator), the lane cannot reach the board, relay's site or `~/.harness` through the
 * environment, and git never prompts.
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of JOB_ENV_STRIPPED) delete env[k];
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["FX_NO_OPEN_BROWSER"] = "1";
  env["FX_AUTO_UPGRADE"] = "0";
  return env;
}
