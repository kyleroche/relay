import type { Metadata } from "next";
import { JsonLd, organizationLd } from "@/components/seo/json-ld";
import { trustPage, type TrustSlug } from "@/lib/content/trust";
import { renderMarkdown } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";

/** One trust page (/about, /contact, /privacy): the Markdown from lib/content/trust.ts rendered as HTML. */

export function trustMetadata(slug: TrustSlug): Metadata {
  const page = trustPage(slug)!;
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/${slug}`, types: { "text/markdown": `${SITE_URL}/${slug}` } },
    robots: { index: true, follow: true },
  };
}

export function TrustArticle({ slug }: { slug: TrustSlug }) {
  const page = trustPage(slug)!;
  return (
    <>
      <JsonLd data={organizationLd()} />
      <article className="mx-auto max-w-3xl py-10 sm:py-14">
        <div className="prose-relay" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.markdown()) }} />
      </article>
    </>
  );
}
