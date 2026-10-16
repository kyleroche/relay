import Link from "next/link";
import { AUTHOR, REPO_URL } from "@/lib/site";
import { dataMode } from "@/lib/data";

export function SiteFooter() {
  const mode = dataMode();
  return (
    <footer className="mt-16 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>
          relay is an open-source harness for coding-agent subscriptions, made by{" "}
          <a href={AUTHOR.url} className="hover:text-foreground" rel="noopener noreferrer">
            {AUTHOR.name}
          </a>
          . Apache-2.0.
          {mode === "mock" && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">demo data</span>}
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
          <Link href="/about" className="hover:text-foreground">About</Link>
          <Link href="/contact" className="hover:text-foreground">Contact</Link>
          <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
          <Link href="/docs" className="hover:text-foreground">Docs</Link>
          <Link href="/docs/api" className="hover:text-foreground">API</Link>
          <a href="/openapi.json" className="hover:text-foreground">OpenAPI</a>
          <a href="/llms.txt" className="hover:text-foreground">llms.txt</a>
          <a href={REPO_URL} className="hover:text-foreground" rel="noopener">GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
