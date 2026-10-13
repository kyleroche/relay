/**
 * Content for /info. One source renders both the HTML page and the text/markdown mirror
 * served through Accept negotiation, so the two never drift.
 */
import { REPO_URL, SITE_URL } from "@/lib/data";

export const TAGLINE = "Your coding-agent subscriptions, working as one system.";

export const WHAT_IS = [
  "relay is an open-source harness for people who pay for more than one coding agent. It turns Claude Code, Codex and Grok Build into a team that shares memory, picks up work from GitHub, runs on machines you already own, and shows you everything it did and what it cost.",
  "There is no new agent to learn and no token ever leaves your machines. GitHub issues are the task bus, a label picks the lane, a self-hosted runner executes the vendor's own CLI under your own login, and a pull request is the result. A Postgres database holds the shared memory and an append-only feed of events; this site is the read model over it.",
  "relay is free and Apache-2.0 licensed. There is no paid tier, no sign-up wall and nothing to buy; you bring the subscriptions you already have.",
];

export const RULES: Array<{ title: string; body: string }> = [
  {
    title: "Tasks move, credentials never do.",
    body: "Every model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI.",
  },
  {
    title: "GitHub is the task bus.",
    body: "An issue is a task, a label picks the lane, a pull request is the result. Nothing of record lives anywhere else.",
  },
  {
    title: "Every step starts fresh with a small brief.",
    body: "No transcript is ever sent to a model. A brief is the repo's rules file, the issue, relevant decisions, and the vendor guidance that matches the intent.",
  },
  {
    title: "Official vendor sources only.",
    body: "Model guidance comes from the vendor's documentation and the skills the vendor publishes. Community prompt guides are excluded unless the user allowlists a domain.",
  },
  {
    title: "Everything is an event.",
    body: "One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.",
  },
];

export const FLOW: Array<{ step: string; detail: string; where: string }> = [
  { step: "Open an issue, add a lane label", detail: "From a phone, a chat bot, or a terminal. agent:claude, agent:codex or agent:grok picks the lane.", where: "GitHub" },
  { step: "A runner claims it", detail: "A self-hosted runner with that label checks out a fresh worktree and compiles a small brief.", where: "your machine" },
  { step: "The vendor CLI runs headless", detail: "claude -p, codex exec or grok -p under the machine's own login. Planner and subagents off.", where: "your machine" },
  { step: "A branch and a PR appear", detail: "The output is snapshotted and pushed; the usage line lands as a PR comment and a step.usage event.", where: "GitHub" },
  { step: "Preview builds, a second model reviews", detail: "Vercel or CI builds the preview. A review lane on a different model comments.", where: "Vercel · your machine" },
  { step: "You merge; memory updates", detail: "Decisions are extracted into shared memory and the rules file is regenerated for every linked repo.", where: "Postgres" },
];

export const INSTALL_AGENT_PROMPT = `Set up relay from ${REPO_URL} following its AGENTS.md "Installing relay for a user" section. Stop and tell me when a step needs my browser.`;

export const INSTALL_SHELL = `git clone ${REPO_URL} && cd relay
pnpm install
pnpm relay doctor     # what is installed, logged in, and reachable
pnpm relay setup      # hooks + memory server into each CLI you have
cd ~/code/some-repo && pnpm --dir ~/relay relay link`;

export const ACCOUNTS: Array<{ tool: string; login: string; plan: string }> = [
  { tool: "Claude Code", login: "claude then /login", plan: "Pro or Max" },
  { tool: "Codex", login: "codex login, or fx login codex", plan: "ChatGPT" },
  { tool: "Grok Build", login: "grok login, or fx login grok", plan: "SuperGrok" },
  { tool: "GitHub", login: "gh auth login", plan: "any" },
];

export const LICENSE = "Apache-2.0. Read AGENTS.md first if you want to contribute; it is written for people and agents alike.";

/** The Markdown mirror of /info. */
export function infoMarkdown(): string {
  const lines: string[] = [];
  lines.push("# relay", "", `> ${TAGLINE}`, "");
  lines.push("## What relay is", "", ...WHAT_IS.flatMap((p) => [p, ""]));
  lines.push("## The five rules", "");
  RULES.forEach((r, i) => lines.push(`${i + 1}. **${r.title}** ${r.body}`));
  lines.push("", "## How a task flows", "");
  FLOW.forEach((f, i) => lines.push(`${i + 1}. **${f.step}** (${f.where}). ${f.detail}`));
  lines.push("", "## Quick install", "", "Paste this into whichever coding agent you use:", "", "```text", INSTALL_AGENT_PROMPT, "```", "", "Or by hand:", "", "```bash", INSTALL_SHELL, "```", "");
  lines.push("## Link your model accounts", "", "relay never asks for a token. Log in to each tool you own, on each machine that will run work.", "");
  lines.push("| Tool | Login | Plan |", "|---|---|---|");
  for (const a of ACCOUNTS) lines.push(`| ${a.tool} | \`${a.login}\` | ${a.plan} |`);
  lines.push("", "## Agents and APIs", "");
  lines.push(`- Public read API: \`${SITE_URL}/api/v1/info\`, \`/api/v1/feed\`, \`/api/v1/projects\` (OpenAPI at \`/openapi.json\`)`);
  lines.push(`- MCP server (Streamable HTTP): \`${SITE_URL}/mcp\``);
  lines.push(`- Agent skill for installing relay: \`${SITE_URL}/.well-known/agent-skills/index.json\``);
  lines.push(`- Docs: \`${SITE_URL}/docs\`, \`${SITE_URL}/llms.txt\``);
  lines.push("", "## License", "", LICENSE, "", `Source: ${REPO_URL}`, "");
  return lines.join("\n");
}
