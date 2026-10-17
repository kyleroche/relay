import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = { title: "Not found" };

const PLACES: Array<{ href: string; label: string; detail: string }> = [
  { href: "/", label: "Overview", detail: "what relay is: five rules, how a task flows, quick install" },
  { href: "/docs", label: "Docs", detail: "architecture, the API and MCP guide, versioning, agent readiness" },
  { href: "/docs/api", label: "API and MCP", detail: "the read API under /api/v1 and the MCP server at /mcp" },
  { href: "/openapi.json", label: "OpenAPI", detail: "the machine-readable description of /api/v1" },
  { href: "/llms.txt", label: "llms.txt", detail: "the site in one file for agents" },
  { href: "/about", label: "About", detail: "who makes relay, and the open-source project behind it" },
];

/**
 * The HTML 404. Next serves it with a real 404 status for any path no route matches; proxy.ts hands agents that
 * prefer Markdown the text/markdown body from /api/markdown instead (lib/negotiate.ts `notFoundMarkdown`).
 */
export default function NotFound() {
  return (
    <section className="mx-auto max-w-2xl py-20 sm:py-24">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nothing at this address</h1>
      <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
        There is no page or resource at this path on relay. Nothing was moved; the address was never served. If you followed a link from the docs or
        from another site, the places below are where the content lives.
      </p>
      <ul className="mt-6 grid gap-2 text-sm sm:grid-cols-2">
        {PLACES.map(({ href, label, detail }) => (
          <li key={href}>
            <Link href={href} className="flex h-full flex-col gap-0.5 rounded-md border px-3 py-2 hover:border-primary/50">
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground">{detail}</span>
              <span className="mt-1 font-mono text-[11px] text-muted-foreground">{href}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-muted-foreground">
        <Link href="/sign-in" className="text-primary underline underline-offset-4">
          Sign in
        </Link>{" "}
        to see this relay&apos;s feed and decide on its tasks. Think a page is missing?{" "}
        <a href={`${REPO_URL}/issues`} className="text-primary underline underline-offset-4" rel="noopener noreferrer">
          Open an issue
        </a>
        .
      </p>
      <div className="mt-8 flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/">Go to the overview</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/docs">Browse the docs</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/contact">Contact</Link>
        </Button>
      </div>
    </section>
  );
}
