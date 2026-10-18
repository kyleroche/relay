import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The two views of the signed-in home: the board (`/`, what every task is doing and the decisions it waits for) and
 * the feed (`/feed`, every event newest first). The control is the page title: it sits first in the header, both
 * labels keep the same weight (only the surface and colour change), and the h1 is read by assistive tech only, so
 * switching views moves nothing in the header. Links rather than client state, so each view keeps its own URL and
 * the feed's filters stay in its query string.
 */
export function HomeTabs({ active, className }: { active: "board" | "feed"; className?: string }) {
  const tabs = [
    { key: "board", href: "/", label: "Board" },
    { key: "feed", href: "/feed", label: "Feed" },
  ] as const;
  return (
    <nav aria-label="Home view" className={cn("inline-flex rounded-md border bg-muted/40 p-0.5 text-base font-medium", className)}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={cn("rounded-[5px] px-3.5 py-1 transition-colors", active === t.key ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
