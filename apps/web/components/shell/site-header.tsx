import Link from "next/link";
import { PlanMeters } from "@/components/meters/plan-meters";
import { Nav } from "@/components/shell/nav";
import { RelayMark } from "@/components/shell/relay-mark";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { ViewerMenu } from "@/components/shell/viewer-menu";
import { getUsage } from "@/lib/data";
import { getSession } from "@/lib/session";

/** The plan meters and the viewer menu depend on who is signed in; the public pages render the header without them. */
export async function SiteHeader() {
  const session = await getSession();
  const usage = session ? await getUsage("5h") : null;
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:gap-6 sm:py-0 sm:h-14">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="relay home">
            <RelayMark className="size-5 text-primary" />
            <span>relay</span>
          </Link>
          <div className="flex items-center gap-2 sm:hidden">
            <ViewerMenu session={session} />
            <ThemeToggle />
          </div>
        </div>
        <Nav className="-mx-1 sm:mx-0" />
        <div className="flex items-center gap-4 sm:ml-auto">
          {usage && (
            <Link href="/usage" className="min-w-0" aria-label="Plan meters, open usage">
              <PlanMeters initial={usage.windows} />
            </Link>
          )}
          <div className="hidden items-center gap-2 sm:flex">
            <ViewerMenu session={session} />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
