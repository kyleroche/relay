import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one line under a page's h1: what the page shows, then "How it works" to the doc that explains it. Explanations
 * live in the docs, not in the chrome (DESIGN.md), so this stays one sentence.
 */
export function PageIntro({ doc, children, className }: { doc: string; children: ReactNode; className?: string }) {
  return (
    <p className={cn("mt-1 max-w-2xl text-sm text-muted-foreground", className)}>
      {children}{" "}
      <Link href={doc} className="whitespace-nowrap underline underline-offset-2 hover:text-foreground">
        How it works
      </Link>
    </p>
  );
}
