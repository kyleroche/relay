import type { Metadata } from "next";
import Link from "next/link";
import { DOCS } from "@/lib/docs";
import { SITE_URL } from "@/lib/data";

export const metadata: Metadata = {
  title: "Docs",
  description: "relay documentation: architecture, the API and MCP server, versioning and deprecation policy, agent readiness, AGENTS.md and README.",
  alternates: { canonical: "/docs", types: { "text/markdown": `${SITE_URL}/docs` } },
};

export default function DocsIndex() {
  return (
    <article className="mx-auto max-w-3xl py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
      <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
        The documents in the repository, served here as HTML and, on request with <code className="rounded bg-muted px-1 font-mono text-xs">Accept: text/markdown</code>, as Markdown. The whole set is also concatenated at{" "}
        <a href="/llms-full.txt" className="text-primary underline underline-offset-4">/llms-full.txt</a>.
      </p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {DOCS.map((d) => (
          <li key={d.slug}>
            <Link href={`/docs/${d.slug}`} className="flex h-full flex-col gap-1 rounded-md border bg-card p-4 hover:border-primary/50">
              <h2 className="font-medium">{d.title}</h2>
              <p className="text-sm text-muted-foreground">{d.description}</p>
              <span className="mt-auto pt-2 font-mono text-[11px] text-muted-foreground">/docs/{d.slug}</span>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
