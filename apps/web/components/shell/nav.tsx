"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
}

/** The signed-in surface. */
export const NAV: readonly NavItem[] = [
  { href: "/", label: "Feed" },
  { href: "/projects", label: "Projects" },
  { href: "/assets", label: "Assets" },
  { href: "/usage", label: "Usage" },
  { href: "/workers", label: "Workers" },
  { href: "/info", label: "Info" },
  { href: "/docs", label: "Docs" },
];

/** What an anonymous visitor can open: the landing is at / for them, so no separate Info entry. */
export const PUBLIC_NAV: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/docs", label: "Docs" },
  { href: "/about", label: "About" },
];

export function Nav({ items = NAV, className }: { items?: readonly NavItem[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className={cn("flex items-center gap-0.5 overflow-x-auto text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
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
