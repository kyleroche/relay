import { describe, it, expect } from "vitest";
import { summaryHtml, summaryLede } from "@/lib/summary";

const MD = `## Purpose
AmpGoGo (app.ampgogo.com) is the product repo for a \`two-sided\` **live-music** marketplace. Access is invite-only.

## Stack and layout
- Next.js 16.2 (App Router), React 19.
- \`app/(app)/\` is the logged-in area.

## Gotchas
- Local dev and production share one database.
`;

describe("summaryLede", () => {
  it("takes the first paragraph under Purpose with the markdown marks stripped", () => {
    expect(summaryLede(MD)).toBe("AmpGoGo (app.ampgogo.com) is the product repo for a two-sided live-music marketplace. Access is invite-only.");
  });
  it("falls back to the first paragraph of a plain summary and clips long ones at a word", () => {
    expect(summaryLede("Just a sentence.")).toBe("Just a sentence.");
    expect(summaryLede(null)).toBeNull();
    const long = summaryLede(`## Purpose\n${"word ".repeat(100)}`, 40)!;
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("summaryHtml", () => {
  it("demotes the headings one level so the page keeps its outline", () => {
    const html = summaryHtml(MD);
    expect(html).toContain("<h3 id=\"purpose\">");
    expect(html).not.toContain("<h2");
    expect(html).toContain("<li>Next.js 16.2 (App Router), React 19.</li>");
    expect(html).toContain("<code>app/(app)/</code>");
  });
});
