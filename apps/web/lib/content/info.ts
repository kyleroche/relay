/**
 * Content for the public landing (served at / to anonymous visitors, and at /info). One source renders both the HTML
 * page and the text/markdown mirror served through Accept negotiation, so the two never drift.
 */
import { AUTHOR, ISSUES_URL, REPO_URL, SITE_URL } from "@/lib/site";

export const TAGLINE = "Your coding-agent subscriptions, working as one system.";

/** The maker line, repeated in visible text so it matches the Organization JSON-LD. */
export const MAKER = `relay is made by ${AUTHOR.name} and released as open source under the Apache-2.0 license. It is free: there is no paid tier, no account to request and nothing for sale. Support is through GitHub issues.`;

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

export const INSTALL_SHELL = `npx @kyleroche/relay doctor     # what is installed, logged in, and reachable (Node 24+)
npx @kyleroche/relay setup      # hooks + memory server into each CLI you have; --yes writes
cd ~/code/some-repo && npx @kyleroche/relay link`;

export const ACCOUNTS: Array<{ tool: string; login: string; plan: string }> = [
  { tool: "Claude Code", login: "claude then /login", plan: "Pro or Max" },
  { tool: "Codex", login: "codex login, or fx login codex", plan: "ChatGPT" },
  { tool: "Grok Build", login: "grok login, or fx login grok", plan: "SuperGrok" },
  { tool: "GitHub", login: "gh auth login", plan: "any" },
];

export const CONTRIBUTE = "Read AGENTS.md first if you want to contribute; it is written for people and agents alike.";
export const LICENSE = `Apache-2.0. ${CONTRIBUTE}`;

/** How an agent gets access by itself. The landing's Markdown mirror renders this; the HTML page points at /docs/api and /llms.txt instead. */
export const ACCESS_INTRO = "No person hands you a token. Register and ask, a person approves once, then retry:";
export const ACCESS_STEPS: string[] = [
  `POST ${SITE_URL}/oauth/device with client_name=<your name> and scope=<space-separated scopes> (tasks:read tasks:write events:write webhooks:write for a task bot). The reply has device_code, user_code (RLAY-XXXX) and verification_uri.`,
  `Tell the person "approve RLAY-XXXX at ${SITE_URL}/activate" (or a bot holding tokens:write approves it with the relay_access_approve MCP tool or POST ${SITE_URL}/api/v1/access/RLAY-XXXX/approve, for scopes it holds itself). Poll POST ${SITE_URL}/oauth/token with grant_type=urn:ietf:params:oauth:grant-type:device_code, device_code and client_id every 5 s until it returns access_token (24 h) and refresh_token (90 d).`,
  `Call ${SITE_URL}/mcp or ${SITE_URL}/api/v1/* with Authorization: Bearer <access_token>; refresh with grant_type=refresh_token before it expires. relay_whoami or GET ${SITE_URL}/api/v1/whoami confirm who you are.`,
];
/** What a person pastes into an agent (bot or a coding agent on a machine with logins) so it connects by itself. The Access page shows this instead of a token form. */
export const CONNECT_AGENT_PROMPT = `Connect to relay at ${SITE_URL} without asking me for a token. If you are running on a machine with my coding-agent logins, run \`npx @kyleroche/relay setup --site ${SITE_URL}\` and show me the code it prints. Otherwise POST ${SITE_URL}/oauth/device with client_name=<your name> and scope="tasks:read tasks:write events:write webhooks:write", tell me the user_code, then poll POST ${SITE_URL}/oauth/token with grant_type=urn:ietf:params:oauth:grant-type:device_code, the device_code and client_id every 5 seconds until you receive access_token and refresh_token, and store both. I will approve the code at ${SITE_URL}/activate. Then call relay_whoami on ${SITE_URL}/mcp with the bearer token and tell me what it returns. If you are inside one of my repositories, also run \`npx @kyleroche/relay link\` there so the project is on relay.`;

/** For a coding agent that is already inside a repository on a machine with the user's logins: how to put that repo on relay. Rendered in /docs/api ("Link a repository") and the landing's Markdown mirror. */
export const LINK_REPO_INTRO = "Inside a repository on a machine with the user's coding-agent logins? Link it yourself; the person approves once at most:";
export const LINK_REPO_STEPS: string[] = [
  `If this machine has not joined the relay yet: npx @kyleroche/relay setup --site ${SITE_URL}. It prints a code; show it to the person, who approves it at ${SITE_URL}/activate (or they give you an invite code for --invite). Needs Node 24.`,
  "In the repository: npx @kyleroche/relay link. It registers the project on the relay, digests the files and writes relay.md, adds the owned section to AGENTS.md or CLAUDE.md, and creates the agent:<lane> labels on GitHub (gh must be logged in). The digest uses the claude login; --no-digest skips it. Re-running is safe.",
  "Optional, so this machine executes the repo's tasks: npx @kyleroche/relay work --install (prints the service it would write; --yes installs it).",
];
export const LINK_REPO_PROMPT = `Link this repository to relay at ${SITE_URL}: run \`npx @kyleroche/relay setup --site ${SITE_URL}\` if this machine has not joined yet and show me the code it prints, then \`npx @kyleroche/relay link\` here. Follow ${SITE_URL}/llms.txt ("Link a repository") if anything is unclear.`;

export const ACCESS_ALTERNATIVES = `Zero-browser path: the operator runs relay invite create --for <you> --scopes … and you redeem the code at POST ${SITE_URL}/oauth/token with grant_type=urn:relay:invite and invite=<code>. Clients with a browser use POST ${SITE_URL}/oauth/register then GET ${SITE_URL}/oauth/authorize (PKCE S256). Metadata: ${SITE_URL}/.well-known/oauth-authorization-server. ${SITE_URL}/tokens is the operator's Access page: approve requests, revoke, invite; minting a token by hand is its fallback.`;

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
  lines.push("", "## Getting access as an agent", "", ACCESS_INTRO, "");
  ACCESS_STEPS.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("", ACCESS_ALTERNATIVES);
  lines.push("", "## Link a repository", "", LINK_REPO_INTRO, "");
  LINK_REPO_STEPS.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("", "Prompt for the agent:", "", "```text", LINK_REPO_PROMPT, "```");
  lines.push("", "## Agents and APIs", "");
  lines.push(`- Public read API: \`${SITE_URL}/api/v1/info\`, \`/api/v1/feed\`, \`/api/v1/projects\` (OpenAPI at \`/openapi.json\`)`);
  lines.push(`- MCP server (Streamable HTTP): \`${SITE_URL}/mcp\` (\`initialize\` and \`tools/list\` need no token)`);
  lines.push(`- Agent skill for installing relay: \`${SITE_URL}/.well-known/agent-skills/index.json\``);
  lines.push(`- Docs: \`${SITE_URL}/docs\`, \`${SITE_URL}/llms.txt\``);
  lines.push("", "## Who makes it", "", MAKER, "", `- Author: [${AUTHOR.name}](${AUTHOR.url})`, `- Source: ${REPO_URL}`, `- Issues and support: ${ISSUES_URL}`);
  lines.push(`- [About](${SITE_URL}/about) · [Contact](${SITE_URL}/contact) · [Privacy](${SITE_URL}/privacy)`);
  lines.push("", "## License", "", LICENSE, "", `Source: ${REPO_URL}`, "");
  return lines.join("\n");
}
