import path from "node:path";
import type { NextConfig } from "next";

// Repo files served at runtime (docs, AGENTS.md, README.md, skills). Traced in so they
// exist in the serverless bundle when the app is deployed from a monorepo.
const repoFiles = ["../../docs/**/*.md", "../../README.md", "../../AGENTS.md", "../../skills/**/*"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @relay/core is a workspace TypeScript package consumed as source.
  transpilePackages: ["@relay/core"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  outputFileTracingIncludes: {
    "/docs": repoFiles,
    "/docs/[slug]": repoFiles,
    "/llms-full.txt": repoFiles,
    "/api/markdown": repoFiles,
    "/.well-known/agent-skills/index.json": repoFiles,
    "/skills/relay/SKILL.md": repoFiles,
  },
  // TODO(auth): proxy.ts holds content negotiation today; session checks for app pages go
  // there too, leaving /info, /docs, /api/webhooks/*, the well-known files and llms.txt public.
};

export default nextConfig;
