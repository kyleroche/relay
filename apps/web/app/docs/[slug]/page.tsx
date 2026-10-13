import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOCS, docMarkdown, renderMarkdown } from "@/lib/docs";
import { REPO_URL, SITE_URL } from "@/lib/data";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const entry = DOCS.find((d) => d.slug === slug);
  if (!entry) return { title: "Not found" };
  return {
    title: entry.title,
    description: entry.description,
    alternates: { canonical: `/docs/${slug}`, types: { "text/markdown": `${SITE_URL}/docs/${slug}` } },
  };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const entry = DOCS.find((d) => d.slug === slug);
  const md = entry ? docMarkdown(slug) : null;
  if (!entry || !md) notFound();
  return (
    <article className="mx-auto max-w-3xl py-10 sm:py-14">
      <p className="mb-6 text-xs text-muted-foreground">
        <Link href="/docs" className="hover:text-foreground">Docs</Link> / {entry.title}
        {entry.file && (
          <>
            {" · "}
            <a href={`${REPO_URL}/blob/main/${entry.file}`} className="hover:text-foreground" rel="noopener noreferrer">
              {entry.file}
            </a>
          </>
        )}
      </p>
      <div className="prose-relay" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
    </article>
  );
}
