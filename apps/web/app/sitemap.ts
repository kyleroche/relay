import type { MetadataRoute } from "next";
import { getProjects, SITE_URL } from "@/lib/data";
import { DOCS } from "@/lib/docs";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const projects = await getProjects();
  const fixed: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE_URL}/info`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE_URL}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/projects`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
    { url: `${SITE_URL}/usage`, lastModified: now, changeFrequency: "hourly", priority: 0.6 },
    { url: `${SITE_URL}/workers`, lastModified: now, changeFrequency: "hourly", priority: 0.5 },
  ];
  const docs: MetadataRoute.Sitemap = DOCS.map((d) => ({ url: `${SITE_URL}/docs/${d.slug}`, lastModified: now, changeFrequency: "weekly", priority: 0.7 }));
  const projectPages: MetadataRoute.Sitemap = projects.map((p) => ({
    url: `${SITE_URL}/projects/${p.slug}`,
    lastModified: p.lastActivity ? new Date(p.lastActivity) : now,
    changeFrequency: "daily",
    priority: 0.6,
  }));
  return [...fixed, ...docs, ...projectPages];
}
