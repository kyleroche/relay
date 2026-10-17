import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one heading under an h1: `text-sm font-medium`, an optional mono count beside it, an optional action on the
 * right (a link, a small button, a hint). Pages are h1 `text-2xl` (landing and docs articles `text-3xl`), then these;
 * nothing else sets a heading size, and nothing is uppercase.
 */
export function SectionHeading({ children, count, action, className, as: Tag = "h2", ...props }: ComponentProps<"h2"> & { count?: number | null; action?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <Tag className={cn("flex min-w-0 flex-wrap items-baseline gap-2 text-sm font-medium", className)} {...props}>
      {children}
      {count != null && <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">{count}</span>}
      {action != null && <span className="ml-auto text-xs font-normal text-muted-foreground">{action}</span>}
    </Tag>
  );
}
