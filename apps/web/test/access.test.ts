import { describe, expect, it } from "vitest";
import { classifyRoute, isApiPath, safeNextPath } from "../lib/access.ts";
import { dataMode, publicReadEnabled } from "../lib/mode.ts";

const anon = { hasBearer: false, publicRead: false };

describe("classifyRoute", () => {
  it("leaves the agent-readiness surface and the sign-in flow public", () => {
    for (const p of [
      "/info",
      "/docs",
      "/docs/api",
      "/docs/agent-readiness",
      "/sign-in",
      "/auth/github/start",
      "/auth/github/callback",
      "/auth/sign-out",
      "/api/v1/info",
      "/openapi.json",
      "/llms.txt",
      "/llms-full.txt",
      "/.well-known/ai-catalog.json",
      "/.well-known/agent-skills/index.json",
      "/.well-known/mcp/server-card.json",
      "/.well-known/oauth-protected-resource",
      "/server.json",
      "/robots.txt",
      "/sitemap.xml",
      "/manifest.webmanifest",
      "/skills/relay/SKILL.md",
      "/mcp",
      "/api/webhooks/github",
      "/api/webhooks/vercel",
      "/api/cron/assets-expire",
      "/api/assets/stream",
      "/api/assets/bundle/abc/123/sig/index.html",
      "/api/assets/upload",
      "/api/markdown",
      "/_next/static/chunk.js",
      "/icon.svg",
      "/opengraph-image",
    ]) {
      expect(classifyRoute(p, anon), p).toBe("public");
    }
  });

  it("protects the app pages and the internal routes", () => {
    for (const p of ["/", "/projects", "/projects/relay", "/usage", "/workers", "/assets", "/assets/abc", "/api/feed", "/api/meters", "/api/assets/mock/abc", "/anything-else"]) {
      expect(classifyRoute(p, anon), p).toBe("session");
    }
  });

  it("lets /api/v1 through with a bearer and gates it otherwise", () => {
    expect(classifyRoute("/api/v1/feed", { hasBearer: true, publicRead: false })).toBe("public");
    expect(classifyRoute("/api/v1/assets/abc/review", { hasBearer: true, publicRead: false, method: "PUT" })).toBe("public");
    expect(classifyRoute("/api/v1/feed", anon)).toBe("session");
    expect(classifyRoute("/api/v1/projects", anon)).toBe("session");
    expect(classifyRoute("/api/v1/assets", { hasBearer: false, publicRead: false, method: "POST" })).toBe("session");
  });

  it("honours RELAY_PUBLIC_READ for anonymous GET reads only", () => {
    const pub = { hasBearer: false, publicRead: true };
    expect(classifyRoute("/api/v1/feed", pub)).toBe("public");
    expect(classifyRoute("/api/v1/projects/relay", { ...pub, method: "HEAD" })).toBe("public");
    expect(classifyRoute("/api/v1/assets", { ...pub, method: "POST" })).toBe("session");
    expect(classifyRoute("/", pub)).toBe("session");
    expect(classifyRoute("/api/feed", pub)).toBe("session");
  });

  it("is not fooled by trailing or doubled slashes", () => {
    expect(classifyRoute("/info/", anon)).toBe("public");
    expect(classifyRoute("//info", anon)).toBe("public");
    expect(classifyRoute("/docs//api", anon)).toBe("public");
    expect(classifyRoute("/information", anon)).toBe("session");
    expect(classifyRoute("/infoX", anon)).toBe("session");
    expect(classifyRoute("/skillsX", anon)).toBe("session");
    expect(classifyRoute("/mcp/other", anon)).toBe("session");
  });

  it("names the API paths that get problem+json instead of a redirect", () => {
    expect(isApiPath("/api/feed")).toBe(true);
    expect(isApiPath("/api/v1/feed")).toBe(true);
    expect(isApiPath("/mcp")).toBe(true);
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/assets/abc")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("accepts same-site paths only", () => {
    expect(safeNextPath("/assets/abc?x=1")).toBe("/assets/abc?x=1");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/sign-in?next=/")).toBe("/");
    expect(safeNextPath("/auth/github/start")).toBe("/");
    expect(safeNextPath("/x\r\nSet-Cookie: a=b")).toBe("/");
  });
});

describe("mode flags", () => {
  it("picks db for RELAY_DATA=db or a DATABASE_URL, else mock", () => {
    expect(dataMode({})).toBe("mock");
    expect(dataMode({ RELAY_DATA: "db" })).toBe("db");
    expect(dataMode({ DATABASE_URL: "postgres://x" })).toBe("db");
    expect(dataMode({ DATABASE_URL: "postgres://x", RELAY_DATA: "mock" })).toBe("mock");
  });

  it("defaults public read on in mock mode only", () => {
    expect(publicReadEnabled({})).toBe(true);
    expect(publicReadEnabled({ RELAY_DATA: "db" })).toBe(false);
    expect(publicReadEnabled({ RELAY_DATA: "db", RELAY_PUBLIC_READ: "1" })).toBe(true);
    expect(publicReadEnabled({ RELAY_PUBLIC_READ: "0" })).toBe(false);
  });
});

describe("unknown paths", () => {
  it("fall through to a 404 rather than a sign-in redirect", () => {
    expect(classifyRoute("/nope", { hasBearer: false, publicRead: false })).toBe("public");
    expect(classifyRoute("/projects/x/does-not-matter", { hasBearer: false, publicRead: false })).toBe("session");
    expect(classifyRoute("/usage", { hasBearer: false, publicRead: false })).toBe("session");
  });
});
