import Link from "next/link";
import { PlanMeters } from "@/components/meters/plan-meters";
import { Nav } from "@/components/shell/nav";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { getUsage } from "@/lib/data";
import { RelayMark } from "@/components/shell/relay-mark";

export async function SiteHeader() {
  const usage = await getUsage("5h");
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:gap-6 sm:py-0 sm:h-14">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="relay home">
            <RelayMark className="size-5 text-primary" />
            <span>relay</span>
          </Link>
          <div className="flex items-center gap-2 sm:hidden">
            <ThemeToggle />
          </div>
        </div>
        <Nav className="-mx-1 sm:mx-0" />
        <div className="flex items-center gap-4 sm:ml-auto">
          <Link href="/usage" className="min-w-0" aria-label="Plan meters, open usage">
            <PlanMeters initial={usage.windows} />
          </Link>
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
