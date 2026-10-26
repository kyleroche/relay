/**
 * Docs served at /docs/*: the repo's own Markdown, read from disk at request time, plus
 * the API guide generated in lib/content/api.ts. The same source feeds the HTML page,
 * the text/markdown mirror and /llms-full.txt.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import { apiMarkdown } from "@/lib/content/api";
import { infoMarkdown } from "@/lib/content/info";
import { REPO_URL } from "@/lib/data";

export interface DocEntry {
  slug: string;
  title: string;
  description: string;
  /** Repo-relative path, or null for generated docs. */
  file: string | null;
}

export const DOCS: DocEntry[] = [
  { slug: "architecture", title: "Architecture", description: "The five rules, the pieces, and a task's life. The source of truth for design.", file: "docs/ARCHITECTURE.md" },
  { slug: "api", title: "API and MCP", description: "The public read API under /api/v1, rate limits, errors, scopes, and the MCP server at /mcp.", file: null },
  { slug: "assets", title: "Assets", description: "Private media storage with versions and an approve-or-reject review loop; the HTTP, MCP and CLI surfaces over it.", file: "docs/ASSETS.md" },
  { slug: "productions", title: "Productions", description: "Running a short on relay: one tracker repo, a project per production, the nodes lane that runs a Griptape Nodes workflow, assets as the deliverable, approve or reject on the board.", file: "docs/PRODUCTIONS.md" },
  { slug: "workers", title: "Workers", description: "How a machine becomes a worker with relay work: lanes from logins, the claim and lease protocol, what a job does, the service files, and cloud lanes.", file: "docs/WORKERS.md" },
  { slug: "worker-agents", title: "Build a worker agent", description: "For the agent inside an app: become a relay worker for a lane of your own over the MCP server with one token: access, register, the doorbell loop, the relay-job manifest, uploading outputs as assets, what the person sees, safety, troubleshooting.", file: "docs/WORKER-AGENTS.md" },
  { slug: "feed", title: "The feed", description: "Every event kind, where it comes from, the worker's usage comment, the ledger view, and the outbound webhook contract.", file: "docs/FEED.md" },
  { slug: "memory", title: "Memory", description: "Decisions, preferences, vendor guidance, the brief compiler, the CLI hooks, and site mode for machines without the database.", file: "docs/MEMORY.md" },
  { slug: "integrations", title: "Connect in one step", description: "How an MCP client, a headless bot, a CLI machine or a GitHub organization gets access: OAuth with consent, the device flow, invite codes, the GitHub App, and the Grok Bot walkthrough.", file: "docs/INTEGRATIONS.md" },
  { slug: "security", title: "Security", description: "The credential rule, prompt-injection posture, sign-in, token lifetimes and revocation, what the consent page shows, and what is never allowed.", file: "docs/SECURITY.md" },
  { slug: "hosting", title: "Hosting", description: "Deploying the web app on Vercel with Neon: environment variables, GitHub OAuth sign-in, the GitHub App (environment or the one-click manifest flow), webhooks, domains.", file: "docs/HOSTING.md" },
  { slug: "versioning", title: "Versioning and deprecation", description: "How the API and MCP surface change, and the RFC 9745 headers used when something is retired.", file: "docs/VERSIONING.md" },
  { slug: "agent-readiness", title: "Agent readiness", description: "What the hosted site serves so agents can find, read, and act on it.", file: "docs/AGENT-READINESS.md" },
  { slug: "agents", title: "AGENTS.md", description: "Instructions for coding agents working in or installing this repo, including the install steps.", file: "AGENTS.md" },
  { slug: "readme", title: "README", description: "What relay does, quick install, and how to link model accounts.", file: "README.md" },
];

/** The monorepo root: apps/web/../.. in dev and in traced output; cwd as a fallback. */
export function repoRoot(): string {
  const cwd = process.cwd();
  const candidates = [path.resolve(/* turbopackIgnore: true */ cwd, "../.."), cwd, path.resolve(/* turbopackIgnore: true */ cwd, "..")];
  for (const c of candidates) if (existsSync(path.join(/* turbopackIgnore: true */ c, "AGENTS.md"))) return c;
  return cwd;
}

export function readRepoFile(rel: string): string | null {
  try {
    return readFileSync(path.join(/* turbopackIgnore: true */ repoRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export function docMarkdown(slug: string): string | null {
  const entry = DOCS.find((d) => d.slug === slug);
  if (!entry) return null;
  if (entry.slug === "api") return apiMarkdown();
  if (!entry.file) return null;
  return readRepoFile(entry.file);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Repo-relative links in the docs become site links or GitHub links. */
function mapHref(href: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const clean = href.replace(/^\.\//, "").replace(/^\/+/, "");
  const byFile = DOCS.find((d) => d.file && (d.file === clean || clean.endsWith(d.file)));
  if (byFile) return `/docs/${byFile.slug}`;
  if (clean === "llms.txt") return "/llms.txt";
  return `${REPO_URL}/blob/main/${clean}`;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens);
      const id = slugify(text);
      return `<h${depth} id="${id}"><a href="#${id}" class="no-underline text-inherit">${text}</a></h${depth}>\n`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const mapped = mapHref(href);
      const external = /^https?:/.test(mapped);
      const t = title ? ` title="${title}"` : "";
      return `<a href="${mapped}"${t}${external ? ' rel="noopener noreferrer"' : ""}>${text}</a>`;
    },
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? "text").split(/\s+/)[0] ?? "text";
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code class="language-${language}">${escaped}\n</code></pre>\n`;
    },
  },
});

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

/** First H1 of a Markdown document, for titles. */
export function firstHeading(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

/** Everything, concatenated, for /llms-full.txt. */
export function fullMarkdown(): string {
  const parts: string[] = [infoMarkdown()];
  for (const d of DOCS) {
    const md = docMarkdown(d.slug);
    if (md) parts.push(`\n\n---\n\n<!-- /docs/${d.slug} -->\n\n${md.trim()}`);
  }
  return parts.join("\n");
}
