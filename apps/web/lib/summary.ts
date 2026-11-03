/**
 * The project summary `relay link` writes is Markdown (## Purpose, ## Stack and layout, bullets, backticks): the
 * project page renders it as such, the list card and the metadata take one plain sentence from it.
 */
import { renderMarkdown } from "./docs";

/** The first paragraph of prose (under "## Purpose" when there is one), markdown marks stripped, for a card or a description. */
export function summaryLede(md: string | null | undefined, max = 240): string | null {
  if (!md) return null;
  const purpose = md.match(/^##\s+purpose\s*\n+([\s\S]*?)(?=\n##\s|\n*$)/im)?.[1] ?? md;
  const para = purpose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#"));
  if (!para) return null;
  const text = para
    .replace(/^[-*]\s+/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text;
}

/** The summary as HTML for `.prose-relay`, its headings demoted one level so the page's own h1 and h2 keep the outline. */
export function summaryHtml(md: string): string {
  return renderMarkdown(md.replace(/^(#{1,5})\s/gm, "#$1 "));
}
