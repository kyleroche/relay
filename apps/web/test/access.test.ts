import { describe, expect, it } from "vitest";
import { classifyRoute, isApiPath, safeNextPath } from "../lib/access.ts";
import { dataMode, publicReadEnabled } from "../lib/mode.ts";

const anon = { hasBearer: false, publicRead: false };

describe("classifyRoute", () => {
  it("leaves the homepage, the trust pages, the agent-readiness surface and the sign-in flow public", () => {
    for (const p of [
      "/",
      "/info",
      "/about",
      "/contact",
      "/privacy",
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
      "/.well-known/api-catalog",
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
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/authorize/decision",
      "/oauth/token",
      "/oauth/device",
      "/oauth/revoke",
      "/_next/static/chunk.js",
      "/icon.svg",
      "/opengraph-image",
    ]) {
      expect(classifyRoute(p, anon), p).toBe("public");
    }
  });

  it("protects the app pages and the internal routes", () => {
    for (const p of ["/tasks", "/tasks/acme/site/42", "/projects", "/projects/relay", "/usage", "/workers", "/assets", "/assets/abc", "/access", "/flow", "/api/flow", "/activate", "/activate/", "/setup", "/setup/github", "/setup/github/callback", "/api/feed", "/api/meters", "/api/assets/mock/abc"]) {
      expect(classifyRoute(p, anon), p).toBe("session");
    }
    // unknown paths are nobody's: they fall through to a real 404, never a sign-in redirect
    // /tokens is a next.config redirect to /access; it never reaches the proxy as a page
    for (const p of ["/anything-else", "/tokens", "/flowX", "/flow/anything", "/api/flowchart"]) expect(classifyRoute(p, anon), p).toBe("unknown");
  });

  it("classifies / as public for everyone; the page itself picks the feed or the landing", () => {
    expect(classifyRoute("/", anon)).toBe("public");
    expect(classifyRoute("/", { hasBearer: false, publicRead: true })).toBe("public");
    expect(classifyRoute("/", { hasBearer: true, publicRead: false })).toBe("public");
  });

  it("lets /api/v1 through with a bearer and gates it otherwise", () => {
    expect(classifyRoute("/api/v1/feed", { hasBearer: true, publicRead: false })).toBe("public");
    expect(classifyRoute("/api/v1/assets/abc/review", { hasBearer: true, publicRead: false, method: "PUT" })).toBe("public");
    expect(classifyRoute("/api/v1/feed", anon)).toBe("session");
    expect(classifyRoute("/api/v1/projects", anon)).toBe("session");
    expect(classifyRoute("/api/v1/assets", { hasBearer: false, publicRead: false, method: "POST" })).toBe("session");
    // the access and invite routes follow the same rule: a bearer (tokens:write) or the session
    expect(classifyRoute("/api/v1/access/RLAY-4F7Q/approve", { hasBearer: true, publicRead: false, method: "POST" })).toBe("public");
    expect(classifyRoute("/api/v1/access/RLAY-4F7Q/approve", { hasBearer: false, publicRead: false, method: "POST" })).toBe("session");
    expect(classifyRoute("/api/v1/invites", { hasBearer: false, publicRead: true, method: "POST" })).toBe("session");
    expect(classifyRoute("/api/v1/whoami", { hasBearer: true, publicRead: false })).toBe("public");
    // approving a task: a tasks:write bearer, or the signed-in person
    expect(classifyRoute("/api/v1/tasks/acme/site%2342/approve", { hasBearer: true, publicRead: false, method: "POST" })).toBe("public");
    expect(classifyRoute("/api/v1/tasks/acme/site%2342/request-changes", { hasBearer: false, publicRead: true, method: "POST" })).toBe("session");
    expect(classifyRoute("/api/v1/tasks/acme/site%2342/requeue", { hasBearer: true, publicRead: false, method: "POST" })).toBe("public");
    expect(classifyRoute("/api/v1/tasks/acme/site%2342/requeue", { hasBearer: false, publicRead: true, method: "POST" })).toBe("session");
    // releasing a task the gate held: a tokens:write bearer (checked by the route), or the signed-in person
    expect(classifyRoute("/api/v1/tasks/acme/site%2342/release", { hasBearer: true, publicRead: false, method: "POST" })).toBe("public");
    expect(classifyRoute("/api/v1/tasks/acme/site%2342/release", { hasBearer: false, publicRead: true, method: "POST" })).toBe("session");
    // the GitHub status of a project: a bearer (feed:read or projects:write, checked by the route) or the session
    expect(classifyRoute("/api/v1/projects/relay/github", { hasBearer: true, publicRead: false })).toBe("public");
    expect(classifyRoute("/api/v1/projects/relay/github", anon)).toBe("session");
    expect(classifyRoute("/api/v1/projects/relay/github", { hasBearer: false, publicRead: true })).toBe("public");
  });

  it("honours RELAY_PUBLIC_READ for anonymous GET reads only", () => {
    const pub = { hasBearer: false, publicRead: true };
    expect(classifyRoute("/api/v1/feed", pub)).toBe("public");
    expect(classifyRoute("/api/v1/projects/relay", { ...pub, method: "HEAD" })).toBe("public");
    expect(classifyRoute("/api/v1/assets", { ...pub, method: "POST" })).toBe("session");
    expect(classifyRoute("/projects", pub)).toBe("session");
    expect(classifyRoute("/api/feed", pub)).toBe("session");
  });

  it("is not fooled by trailing or doubled slashes", () => {
    expect(classifyRoute("/info/", anon)).toBe("public");
    expect(classifyRoute("//info", anon)).toBe("public");
    expect(classifyRoute("/docs//api", anon)).toBe("public");
    expect(classifyRoute("/projects/", anon)).toBe("session");
    expect(classifyRoute("/tasks/", anon)).toBe("session");
    expect(classifyRoute("/tasksX", anon)).toBe("unknown");
    expect(classifyRoute("//assets", anon)).toBe("session");
    expect(classifyRoute("/information", anon)).toBe("unknown");
    expect(classifyRoute("/infoX", anon)).toBe("unknown");
    expect(classifyRoute("/skillsX", anon)).toBe("unknown");
    expect(classifyRoute("/mcp/other", anon)).toBe("unknown");
    expect(classifyRoute("/aboutus", anon)).toBe("unknown");
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
    expect(safeNextPath("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    expect(safeNextPath("/oauth/token")).toBe("/");
    expect(safeNextPath("/activate?code=RLAY-4F7Q")).toBe("/activate?code=RLAY-4F7Q");
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
  it("are neither public nor protected: they fall through to a 404 rather than a sign-in redirect", () => {
    expect(classifyRoute("/nope", anon)).toBe("unknown");
    expect(classifyRoute("/anything-else/deeper", anon)).toBe("unknown");
    expect(classifyRoute("/.well-known/missing", anon)).toBe("public"); // Next still answers 404; the prefix is public
    expect(classifyRoute("/projects/x/does-not-matter", anon)).toBe("session");
    expect(classifyRoute("/usage", anon)).toBe("session");
  });
});
