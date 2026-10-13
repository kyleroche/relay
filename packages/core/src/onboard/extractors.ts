/**
 * Site-specific body extractors. Each returns title+text for a page when it recognises the host, or undefined to
 * fall back to the generic HTML walker. Links are always collected by the generic pass in html.ts.
 */
export interface SiteExtract {
  title: string;
  text: string;
  updatedAt?: string;
  canonicalUrl?: string;
}

interface ByteplusDoc {
  Title?: string;
  EnTitle?: string;
  MDContent?: string;
  UpdatedTime?: string;
  CanonicalURL?: string;
}

/** BytePlus markdown carries editor escapes (`\-`) and layout HTML (<columns>, <span id>, tip divs). Normalise to plain markdown. */
function cleanByteplusMarkdown(md: string): string {
  return md
    .replace(/[​‌‍﻿]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/<div[^>]*data-tips-is-title="true"[^>]*>[^<]*<\/div>\s*/g, "")
    .replace(/<div[^>]*data-tips[^>]*>([\s\S]*?)<\/div>/g, (_m, inner: string) => "> " + inner.trim())
    .replace(/<\/?columns(Item)?[^>]*>/g, "")
    .replace(/<span[^>]*><\/span>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/\\([-_*#.[\]()`>|~])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * docs.byteplus.com embeds the document as markdown in window._ROUTER_DATA → loaderData → …page → curDoc.MDContent.
 * A curDoc without MDContent is a shell or rich-delta page: we return empty text so the crawler skips it instead of
 * falling back to the nav-only DOM.
 */
function byteplus(html: string): SiteExtract | undefined {
  const marker = "window._ROUTER_DATA = ";
  const start = html.indexOf(marker);
  if (start < 0) return undefined;
  const from = start + marker.length;
  const end = html.indexOf("</script>", from);
  if (end < 0) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(html.slice(from, end).trim().replace(/;$/, ""));
  } catch {
    return undefined;
  }
  let doc: ByteplusDoc | undefined;
  const walk = (o: unknown, depth: number): void => {
    if (doc || depth > 8 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) return void o.forEach((v) => walk(v, depth + 1));
    const rec = o as Record<string, unknown>;
    if (rec["curDoc"] && typeof rec["curDoc"] === "object") {
      doc = rec["curDoc"] as ByteplusDoc;
      return;
    }
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  walk(data, 0);
  if (!doc) return undefined;
  const d = doc as ByteplusDoc;
  const out: SiteExtract = { title: (d.EnTitle || d.Title || "").trim(), text: cleanByteplusMarkdown(d.MDContent ?? "") };
  if (d.UpdatedTime) out.updatedAt = d.UpdatedTime;
  if (d.CanonicalURL) out.canonicalUrl = d.CanonicalURL;
  return out;
}

/** Canonical form for dedupe: docs.byteplus.com serves /docs/… and /en/docs/… for the same page. */
export function normalizeSiteUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (/(^|\.)byteplus\.com$/i.test(u.hostname) && /^\/docs\//.test(u.pathname)) u.pathname = "/en" + u.pathname;
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

export const siteExtractors: Array<{ hosts: RegExp; extract: (html: string, url: string) => SiteExtract | undefined }> = [
  { hosts: /(^|\.)byteplus\.com$/i, extract: byteplus },
];

export function siteExtract(html: string, url: string): SiteExtract | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  for (const x of siteExtractors) if (x.hosts.test(host)) return x.extract(html, url);
  return undefined;
}
