import Link from "next/link";
import { PlanMeters } from "@/components/meters/plan-meters";
import { Nav, NAV, PUBLIC_NAV } from "@/components/shell/nav";
import { RelayMark } from "@/components/shell/relay-mark";
import { ViewerMenu } from "@/components/shell/viewer-menu";
import { getUsage } from "@/lib/data";
import { getSession } from "@/lib/session";

/**
 * One row at lg and up (brand · nav · meters · avatar); two rows below (brand · meter pill · avatar, then the nav on
 * its own row). The plan meters and the viewer menu depend on who is signed in; the public pages render the header
 * without them.
 */
export async function SiteHeader() {
  const session = await getSession();
  const usage = session ? await getUsage("5h") : null;
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 px-4 py-2 lg:h-14 lg:flex-nowrap lg:gap-x-6 lg:py-0">
        <Link href="/" className="order-1 flex h-7 items-center gap-2 font-semibold tracking-tight" aria-label="relay home">
          <RelayMark className="size-5 text-primary" />
          <span>relay</span>
        </Link>
        <Nav items={session ? NAV : PUBLIC_NAV} className="order-3 -mx-2.5 w-full pt-1 lg:order-2 lg:mx-0 lg:w-auto lg:pt-0" />
        <div className="order-2 ml-auto flex items-center gap-3 lg:order-3 lg:gap-4">
          {usage && <PlanMeters initial={usage.windows} />}
          <ViewerMenu session={session} />
        </div>
      </div>
    </header>
  );
}
