"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
}

/**
 * The signed-in primary nav: the objects a viewer looks at daily. Machine and access configuration (workers, tokens,
 * the GitHub App), the theme and the reference pages live in the avatar menu; see DESIGN.md, "Information architecture".
 */
export const NAV: readonly NavItem[] = [
  { href: "/", label: "Board" },
  { href: "/projects", label: "Projects" },
  { href: "/assets", label: "Assets" },
  { href: "/usage", label: "Usage" },
];

/** What an anonymous visitor can open: the landing is at / for them, so Overview points there. Sign in sits on the right. */
export const PUBLIC_NAV: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/docs", label: "Docs" },
];

/** Five short labels fit one row at 375px, so the nav wraps rather than scrolls. */
export function Nav({ items = NAV, className }: { items?: readonly NavItem[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className={cn("flex flex-wrap items-center gap-0.5 text-sm", className)}>
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" || pathname === "/feed" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground",
              active ? "text-foreground font-medium" : "text-muted-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
