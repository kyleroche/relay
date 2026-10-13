import * as cheerio from "cheerio";
import { siteExtract } from "./extractors.ts";

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  etag?: string;
}

// Some vendor doc sites only server-render for browser user agents; identify as a browser but keep a harness marker.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 relay-harness/0.0.1";

export async function fetchPage(url: string, timeoutMs = 30_000): Promise<FetchedPage> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: ctl.signal });
    const html = await res.text();
    const etag = res.headers.get("etag") ?? undefined;
    return etag ? { url: res.url || url, status: res.status, html, etag } : { url: res.url || url, status: res.status, html };
  } finally {
    clearTimeout(t);
  }
}

export interface ExtractedDoc {
  title: string;
  text: string;
  links: Array<{ url: string; text: string }>;
}

/** Official-source gate: host must equal an allowed domain or be a subdomain of one. Entries may carry a path prefix (github.com/anthropics). */
export function isOfficial(url: string, domains: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return domains.some((d) => {
    const [host, ...rest] = d.split("/");
    const prefix = rest.length ? "/" + rest.join("/") : "";
    const hostOk = u.hostname === host || u.hostname.endsWith("." + host!);
    return hostOk && (prefix === "" || u.pathname === prefix || u.pathname.startsWith(prefix + "/"));
  });
}

const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "li", "ul", "ol", "table", "tr", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "dd", "dt", "dl", "figure", "figcaption", "aside", "nav", "details", "summary"]);
const SKIP = new Set(["script", "style", "noscript", "svg", "iframe", "template", "button", "input", "select", "textarea", "nav", "header", "footer"]);

/**
 * Find the content column: starting at <body>, descend into the child holding most of the text while it still
 * holds ≥ 60% of its parent's text. Nav/sidebars/footers fall away because they are the smaller siblings.
 * Doc sites often have several <main>/<article> elements, so tag names alone are not reliable.
 */
function contentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<import("domhandler").Element> {
  const textLen = (el: cheerio.Cheerio<import("domhandler").Element>) => el.text().replace(/\s+/g, " ").length;
  let cur = $("body");
  for (let depth = 0; depth < 40; depth++) {
    const kids = cur.children().toArray().filter((k) => !SKIP.has(String(k.name).toLowerCase()));
    if (!kids.length) break;
    let best = kids[0]!;
    let bestLen = -1;
    for (const k of kids) {
      const l = textLen($(k));
      if (l > bestLen) (best = k), (bestLen = l);
    }
    const curLen = textLen(cur);
    if (curLen === 0 || bestLen < curLen * 0.6) break;
    cur = $(best);
  }
  return cur;
}

/** Convert HTML to a markdown-ish plain text that preserves headings, lists, code blocks and table rows. */
export function extractDoc(html: string, baseUrl: string): ExtractedDoc {
  const $ = cheerio.load(html);
  const site = siteExtract(html, baseUrl);
  if (site) return { title: site.title || $("title").first().text().trim() || baseUrl, text: site.text, links: collectLinks($, baseUrl) };
  const root = contentRoot($);
  const h1 = root.find("h1").first().text().replace(/\s+/g, " ").trim();
  const title = (h1 || $("title").first().text() || baseUrl).replace(/\s+/g, " ").trim();

  const out: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any, inPre: boolean): void => {
    if (node.type === "text") {
      const raw = String(node.data ?? "").replace(/[​‌‍﻿]/g, "");
      out.push(inPre ? raw : raw.replace(/\s+/g, " "));
      return;
    }
    if (node.type !== "tag") return;
    const name = String(node.name).toLowerCase();
    if (SKIP.has(name)) return;
    if (name === "br") {
      out.push("\n");
      return;
    }
    if (/^h[1-6]$/.test(name)) {
      out.push("\n\n" + "#".repeat(Number(name[1])) + " ");
      for (const c of node.children ?? []) walk(c, false);
      out.push("\n\n");
      return;
    }
    if (name === "pre") {
      out.push("\n\n```\n");
      for (const c of node.children ?? []) walk(c, true);
      out.push("\n```\n\n");
      return;
    }
    if (name === "li") out.push("\n- ");
    else if (name === "tr") out.push("\n");
    else if (name === "td" || name === "th") out.push(" | ");
    else if (BLOCK.has(name)) out.push("\n\n");
    for (const c of node.children ?? []) walk(c, inPre);
    if (BLOCK.has(name)) out.push("\n");
  };
  for (const c of root.contents().toArray()) walk(c, false);

  const text = out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n- \s*)+(?=\n- )/g, "")
    .trim();

  return { title, text, links: collectLinks($, baseUrl) };
}

function collectLinks($: cheerio.CheerioAPI, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const u = new URL(href, baseUrl);
      u.hash = "";
      const s = u.toString();
      if (!/^https?:/.test(s) || seen.has(s)) return;
      seen.add(s);
      links.push({ url: s, text: $(a).text().replace(/\s+/g, " ").trim() });
    } catch {
      /* ignore bad hrefs */
    }
  });
  return links;
}
