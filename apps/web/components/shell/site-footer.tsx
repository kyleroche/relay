import Link from "next/link";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { AUTHOR, REPO_URL } from "@/lib/site";
import { getSession } from "@/lib/session";

/**
 * The public and reference pages (DESIGN.md, "Information architecture"). Anonymous visitors get their theme control
 * here; signed-in viewers have it in the avatar menu, whose header row also carries the "demo" tag in mock mode.
 */
export async function SiteFooter() {
  const session = await getSession();
  return (
    <footer className="mt-16 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>
          relay is an open-source harness for coding-agent subscriptions, made by{" "}
          <a href={AUTHOR.url} className="hover:text-foreground" rel="noopener noreferrer">
            {AUTHOR.name}
          </a>
          . Apache-2.0.
        </p>
        <div className="flex items-center gap-3">
          <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/info" className="hover:text-foreground">Overview</Link>
            <Link href="/docs" className="hover:text-foreground">Docs</Link>
            <Link href="/docs/api" className="hover:text-foreground">API</Link>
            <a href="/openapi.json" className="hover:text-foreground">OpenAPI</a>
            <a href="/llms.txt" className="hover:text-foreground">llms.txt</a>
            <Link href="/about" className="hover:text-foreground">About</Link>
            <Link href="/contact" className="hover:text-foreground">Contact</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <a href={REPO_URL} className="hover:text-foreground" rel="noopener">Source</a>
          </nav>
          {!session && <ThemeToggle />}
        </div>
      </div>
    </footer>
  );
}
