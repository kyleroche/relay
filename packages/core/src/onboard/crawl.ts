import type { ModelSpec } from "./registry.ts";
import { extractDoc, fetchPage, isOfficial } from "./html.ts";
import { normalizeSiteUrl } from "./extractors.ts";
import { sha256, sleep, type Log, noopLog } from "../util.ts";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  sha256: string;
  etag?: string;
}

/**
 * Bounded BFS from the model's seed URLs. Every URL passes the official-domain gate before it is fetched;
 * anything else is dropped and logged. Non-seed links must also match the crawl include pattern and a keyword.
 */
export async function crawlModelDocs(spec: ModelSpec, docDomains: string[], log: Log = noopLog): Promise<{ pages: CrawledPage[]; dropped: string[]; thin: string[] }> {
  const seeds = spec.seedUrls.map(normalizeSiteUrl);
  const queue: Array<{ url: string; seed: boolean }> = seeds.map((url) => ({ url, seed: true }));
  const seen = new Set<string>(seeds);
  const pages: CrawledPage[] = [];
  const dropped: string[] = [];
  const thin: string[] = [];

  while (queue.length && pages.length < spec.crawl.maxPages) {
    const { url, seed } = queue.shift()!;
    if (!isOfficial(url, docDomains)) {
      dropped.push(url);
      log(`drop (not official): ${url}`);
      continue;
    }
    // Doc sites sometimes serve a stripped page under rapid sequential requests (seen on docs.byteplus.com:
    // curDoc present, MDContent empty). Retry a thin result twice with a longer pause before giving up.
    let doc: ReturnType<typeof extractDoc> | undefined;
    let status = 0;
    let etag: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(2000 * attempt);
      let page;
      try {
        page = await fetchPage(url);
      } catch (e) {
        log(`fetch failed: ${url} (${e instanceof Error ? e.message : e})`);
        break;
      }
      status = page.status;
      etag = page.etag;
      if (page.status >= 400) break;
      const d = extractDoc(page.html, page.url);
      if (d.text.length >= 400) {
        doc = d;
        break;
      }
      log(`thin response (${d.text.length} chars) attempt ${attempt + 1}: ${url}`);
    }
    if (status >= 400) {
      log(`http ${status}: ${url}`);
      continue;
    }
    if (!doc) {
      log(`skip (thin page after retries): ${url}`);
      thin.push(url);
      continue;
    }
    const rec: CrawledPage = { url, title: doc.title, text: doc.text, sha256: sha256(doc.text) };
    if (etag) rec.etag = etag;
    pages.push(rec);
    log(`fetched ${seed ? "seed" : "link"}: ${doc.title} (${doc.text.length} chars, ${doc.links.length} links)`);

    for (const l of doc.links) {
      const nu = normalizeSiteUrl(l.url);
      if (seen.has(nu)) continue;
      let u: URL;
      try {
        u = new URL(nu);
      } catch {
        continue;
      }
      if (!isOfficial(nu, docDomains)) continue;
      if (!spec.crawl.include.test(u.pathname)) continue;
      const hay = (nu + " " + l.text).toLowerCase();
      if (!spec.crawl.keywords.some((k) => hay.includes(k))) continue;
      seen.add(nu);
      queue.push({ url: nu, seed: false });
    }
    await sleep(1000);
  }
  return { pages, dropped, thin };
}
