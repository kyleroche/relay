import Link from "next/link";
import { Pill } from "@/components/ui/pill";
import type { ProjectSummary } from "@/lib/types";

/**
 * The board's one filter: a row of project pills, "All" first, the current one in the primary tone, each a link to
 * `/?project=<slug>` so the filter lives in the URL (and survives the board's refresh and the "Show N more" links).
 * Drawn only when there is something to choose between. DESIGN.md, "Board".
 */
export function ProjectFilter({ projects, current, className }: { projects: ProjectSummary[]; current?: string; className?: string }) {
  if (projects.length < 2 && !current) return null;
  const items = [{ slug: "all", label: "All", href: "/" }, ...projects.map((p) => ({ slug: p.slug, label: p.slug, href: `/?project=${encodeURIComponent(p.slug)}` }))];
  const active = current ?? "all";
  return (
    <nav aria-label="Project filter" className={className}>
      <ul className="flex flex-wrap items-center gap-1">
        {items.map((it) => (
          <Pill key={it.slug} asChild mono={it.slug !== "all"} tone={active === it.slug ? "primary" : "muted"} className="hover:text-foreground">
            <li>
              <Link href={it.href} aria-current={active === it.slug ? "true" : undefined}>
                {it.label}
              </Link>
            </li>
          </Pill>
        ))}
      </ul>
    </nav>
  );
}
