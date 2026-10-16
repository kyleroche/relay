import type { MetadataRoute } from "next";
import { TRUST_PAGES } from "@/lib/content/trust";
import { DOCS } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";

/**
 * Every public page. The feed, projects, usage, workers and assets need a signed-in session and would only redirect a
 * crawler to /sign-in, so they are not listed; /info renders the landing with canonical /, so / stands for both.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const fixed: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    ...TRUST_PAGES.map((p) => ({ url: `${SITE_URL}/${p.slug}`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.5 })),
  ];
  const docs: MetadataRoute.Sitemap = DOCS.map((d) => ({ url: `${SITE_URL}/docs/${d.slug}`, lastModified: now, changeFrequency: "weekly", priority: 0.7 }));
  return [...fixed, ...docs];
}
