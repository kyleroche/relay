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
    "/oauth/**": migrations,
    "/activate": migrations,
    "/setup/**": migrations,
    "/access": migrations,
    "/": migrations,
    "/assets": migrations,
    "/assets/[id]": migrations,
    "/projects": migrations,
    "/projects/[slug]": migrations,
    "/usage": migrations,
    "/workers": migrations,
  },
  // The Access page moved from /tokens to /access; old links keep working.
  async redirects() {
    return [{ source: "/tokens", destination: "/access", permanent: true }];
  },
  // proxy.ts holds the sign-in gate (lib/access.ts says what is public) and the Accept negotiation for /info and /docs.
  async headers() {
    const everywhere = [
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    ];
    return [
      { source: "/:path*", headers: everywhere },
      // Nothing frames the app. The asset viewers under /api/assets are framed by the app itself and carry their own
      // sandbox CSP (stream, bundle, mock), so they are the one place these two headers are not set.
      { source: "/((?!api/assets/).*)", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }, { key: "X-Frame-Options", value: "DENY" }] },
    ];
  },
};

export default nextConfig;
