import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: ReactNode;
  /** Omit on the current page; it then renders as plain text with aria-current. */
  href?: string;
  /** For identifiers (a task id); names stay in sans. */
  mono?: boolean;
}

/**
 * The one trail above a detail page's h1: "Tasks / acme/site#42", "Projects / relay", "Assets / relay", "Docs / API".
 * Anything after the trail (the docs page's source link) goes in `children` and sits on the same line.
 */
export function Breadcrumb({ items, children, className }: { items: Crumb[]; children?: ReactNode; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground", className)}>
      <ol className="flex flex-wrap items-center gap-x-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-x-1.5">
            {i > 0 && <span aria-hidden="true">/</span>}
            {it.href ? (
              <Link href={it.href} className={cn("hover:text-foreground", it.mono && "font-mono")}>
                {it.label}
              </Link>
            ) : (
              <span aria-current="page" className={cn(it.mono && "font-mono")}>
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
      {children}
    </nav>
  );
}
