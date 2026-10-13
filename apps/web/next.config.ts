import path from "node:path";
import type { NextConfig } from "next";

// Repo files served at runtime (docs, AGENTS.md, README.md, skills). Traced in so they
// exist in the serverless bundle when the app is deployed from a monorepo.
const repoFiles = ["../../docs/**/*.md", "../../README.md", "../../AGENTS.md", "../../skills/**/*"];
// Plain-SQL migrations run on first use (lib/db.ts) and are read from disk by @relay/core.
const migrations = ["../../packages/core/src/db/migrations/*.sql"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @relay/core and @relay/mcp are workspace TypeScript packages consumed as source.
  transpilePackages: ["@relay/core", "@relay/mcp"],
  // Native and wasm-backed drivers load from node_modules at runtime instead of being bundled.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg", "sharp", "@vercel/blob"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  outputFileTracingIncludes: {
    "/docs": repoFiles,
    "/docs/[slug]": repoFiles,
    "/llms-full.txt": repoFiles,
    "/api/markdown": repoFiles,
    "/.well-known/agent-skills/index.json": repoFiles,
    "/skills/relay/SKILL.md": repoFiles,
    "/api/**": migrations,
    "/mcp": migrations,
    "/": migrations,
    "/assets": migrations,
    "/assets/[id]": migrations,
    "/projects": migrations,
    "/projects/[slug]": migrations,
    "/usage": migrations,
    "/workers": migrations,
  },
  // TODO(auth): proxy.ts holds content negotiation today; session checks for app pages go
  // there too, leaving /info, /docs, /api/webhooks/*, the well-known files and llms.txt public.
};

export default nextConfig;
