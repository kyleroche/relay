import { describe, expect, it } from "vitest";
import { hasMarkdownMirror, homeDecision, homeView, negotiateFormat, notFoundMarkdown, parseAccept } from "../lib/negotiate.ts";

describe("negotiateFormat", () => {
  it("serves Markdown only when the client prefers it over HTML", () => {
    expect(negotiateFormat("text/markdown")).toBe("markdown");
    expect(negotiateFormat("text/markdown, text/html;q=0.5")).toBe("markdown");
    expect(negotiateFormat("text/markdown;q=0.9, */*;q=0.1")).toBe("markdown");
    expect(negotiateFormat("text/html, text/markdown;q=0.5")).toBe("html");
    expect(negotiateFormat("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe("html");
    expect(negotiateFormat("*/*")).toBe("html");
    expect(negotiateFormat(null)).toBe("html");
    expect(negotiateFormat(undefined)).toBe("html");
    // text/* covers both; HTML wins the tie
    expect(negotiateFormat("text/*")).toBe("html");
  });

  it("answers none when the client accepts neither", () => {
    expect(negotiateFormat("application/json")).toBe("none");
    expect(negotiateFormat("text/html;q=0, text/markdown;q=0")).toBe("none");
  });

  it("parses quality values and ignores empty ranges", () => {
    expect(parseAccept("text/markdown;q=0.8, , text/html")).toEqual([
      { type: "text/markdown", q: 0.8 },
      { type: "text/html", q: 1 },
    ]);
  });
});

describe("the homepage", () => {
  it("is the feed for a signed-in viewer and for mock mode, the landing otherwise", () => {
    expect(homeView({ signedIn: true, mock: false })).toBe("app");
    expect(homeView({ signedIn: false, mock: true })).toBe("app");
    expect(homeView({ signedIn: true, mock: true })).toBe("app");
    expect(homeView({ signedIn: false, mock: false })).toBe("landing");
  });

  it("negotiates Markdown for the anonymous landing only", () => {
    expect(homeDecision({ signedIn: false, mock: false, accept: "text/markdown" })).toEqual({ view: "landing", format: "markdown" });
    expect(homeDecision({ signedIn: false, mock: false, accept: "text/html" })).toEqual({ view: "landing", format: "html" });
    expect(homeDecision({ signedIn: false, mock: false, accept: "application/json" })).toEqual({ view: "landing", format: "none" });
    // the feed is an app page: a signed-in agent asking for Markdown still gets HTML
    expect(homeDecision({ signedIn: true, mock: false, accept: "text/markdown" })).toEqual({ view: "app" });
    expect(homeDecision({ signedIn: false, mock: true, accept: "text/markdown" })).toEqual({ view: "app" });
  });
});

describe("Markdown mirrors", () => {
  it("exist for the landing, the trust pages and the docs", () => {
    for (const p of ["/", "/info", "/about", "/contact", "/privacy", "/docs", "/docs/api"]) expect(hasMarkdownMirror(p), p).toBe(true);
    for (const p of ["/projects", "/openapi.json", "/aboutus", "/nope", "/mcp"]) expect(hasMarkdownMirror(p), p).toBe(false);
  });

  it("gives unknown paths a short, helpful Markdown 404 body", () => {
    const md = notFoundMarkdown("/nope", "https://relay.test");
    expect(md.startsWith("# 404")).toBe(true);
    expect(md).toContain("`/nope`");
    expect(md).toContain("https://relay.test/docs");
    expect(md).toContain("https://relay.test/llms.txt");
    expect(md.length).toBeGreaterThan(200);
    // no way to break out of the code span or inject headers through the path
    expect(notFoundMarkdown("/x`\r\n# hacked", "https://relay.test")).not.toMatch(/hacked\n/);
    expect(notFoundMarkdown("/" + "a".repeat(500), "https://relay.test")).toContain("a".repeat(199) + "`");
  });
});
