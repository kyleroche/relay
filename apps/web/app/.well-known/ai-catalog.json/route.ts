import { NextResponse } from "next/server";
import { REPO_URL, SITE_URL } from "@/lib/data";
import { DOCS } from "@/lib/docs";
import { APP_VERSION } from "@/lib/info-doc";

/** Site catalog for agents: what is here and how to use it, in one file. */
export function GET() {
  return NextResponse.json(
    {
      version: "1.0",
      name: "relay",
      description:
        "Open-source harness that turns one person's coding-agent subscriptions (Claude Code, Codex, Grok) into one system. Free, Apache-2.0.",
      site_type: "app",
      url: SITE_URL,
      software_version: APP_VERSION,
      license: "Apache-2.0",
      pricing: { model: "free", notes: "No paid tier. Bring your own vendor subscriptions." },
      repository: REPO_URL,
      pages: [
        { url: `${SITE_URL}/`, title: "Feed", description: "Every event across projects, newest first." },
        { url: `${SITE_URL}/info`, title: "What relay is", description: "The five rules, how a task flows, quick install, linking accounts.", markdown: true },
        { url: `${SITE_URL}/projects`, title: "Projects", description: "Linked repositories with decisions and digest coverage." },
        { url: `${SITE_URL}/usage`, title: "Usage", description: "Calls, tokens, cost equivalent and plan meters per subscription." },
        { url: `${SITE_URL}/workers`, title: "Workers", description: "Health of self-hosted runners." },
        ...DOCS.map((d) => ({ url: `${SITE_URL}/docs/${d.slug}`, title: d.title, description: d.description, markdown: true })),
      ],
      apis: [
        { type: "openapi", url: `${SITE_URL}/openapi.json`, base_url: `${SITE_URL}/api/v1`, docs: `${SITE_URL}/docs/api` },
        { type: "mcp", url: `${SITE_URL}/mcp`, transport: "streamable-http", server_card: `${SITE_URL}/.well-known/mcp/server-card.json`, registry: `${SITE_URL}/server.json` },
      ],
      skills: `${SITE_URL}/.well-known/agent-skills/index.json`,
      llms_txt: `${SITE_URL}/llms.txt`,
      llms_full_txt: `${SITE_URL}/llms-full.txt`,
      sitemap: `${SITE_URL}/sitemap.xml`,
      auth: { scheme: "bearer", metadata: `${SITE_URL}/.well-known/oauth-protected-resource`, public_read: true },
      versioning: `${SITE_URL}/docs/versioning`,
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
