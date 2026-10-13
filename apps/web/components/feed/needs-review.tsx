import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Thumb } from "@/components/assets/asset-card";
import { ActorChip } from "@/components/feed/actor-chip";
import { fmtAgo } from "@/lib/format";
import type { Asset } from "@/lib/types";

/** Pending assets, at the top of the feed: the one thing on this page that is waiting for the reader. */
export function NeedsReview({ assets, now }: { assets: Asset[]; now: number }) {
  if (!assets.length) return null;
  const shown = assets.slice(0, 6);
  return (
    <section aria-labelledby="needs-review-h" className="rounded-md border border-warn/40 bg-warn/5 p-3">
      <h2 id="needs-review-h" className="flex items-baseline gap-2 text-sm font-medium">
        Needs review
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{assets.length}</span>
        <Link href="/assets?status=pending" className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline">
          All pending <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </h2>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((a) => (
          <li key={a.id}>
            <Link href={`/assets/${a.id}`} className="flex items-center gap-3 rounded-md border bg-card p-2 transition-colors hover:border-primary/50">
              <Thumb asset={a} className="size-12 shrink-0 rounded-sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{a.title}</span>
                <span className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  {a.project && <span>{a.project}</span>}
                  {(a.pr ?? a.issue) && <span>#{a.pr ?? a.issue}</span>}
                  <span>v{a.version}</span>
                  <span className="ml-auto">{fmtAgo(a.created_at, now)}</span>
                </span>
                <span className="mt-1 block">
                  <ActorChip actor={a.created_by} className="text-muted-foreground" />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
