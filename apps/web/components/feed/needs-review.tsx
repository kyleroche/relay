import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Thumb } from "@/components/assets/asset-card";
import { ActorChip } from "@/components/feed/actor-chip";
import { PreviewBadge } from "@/components/tasks/state-badge";
import { RelTime } from "@/components/ui/rel-time";
import { SectionHeading } from "@/components/ui/section-heading";
import { taskPagePath } from "@/lib/tasks";
import type { Asset, TaskView } from "@/lib/types";

/**
 * What is waiting for the reader, at the top of the feed: tasks held at the injection gate and tasks in review (a
 * pull request is open, perhaps a preview) above pending assets. Each task links to its page, where the decision is made.
 */
export function NeedsReview({ tasks, assets, now }: { tasks: TaskView[]; assets: Asset[]; now: number }) {
  if (!tasks.length && !assets.length) return null;
  const shownTasks = tasks.slice(0, 6);
  const shownAssets = assets.slice(0, 6);
  return (
    <section aria-labelledby="needs-review-h" className="flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/5 p-3">
      <SectionHeading id="needs-review-h" count={tasks.length + assets.length}>
        Needs review
      </SectionHeading>
      {tasks.length > 0 && (
        <div>
          <h3 className="flex items-baseline gap-2 text-xs text-muted-foreground">
            Tasks <span className="font-mono tabular-nums">{tasks.length}</span>
            <Link href="/tasks" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
              All tasks <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          </h3>
          <ul className="mt-1.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shownTasks.map((t) => (
              <li key={t.id}>
                <Link href={taskPagePath(t)} className="flex h-full flex-col gap-1 rounded-md border bg-card p-2 transition-colors hover:border-primary/50">
                  <span className="truncate text-sm">{t.run_summary ?? t.summary ?? t.id}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate font-mono">{t.id}</span>
                    {t.state === "held" && <span className="text-warn">held at the gate</span>}
                    {t.pr && (
                      <span className="inline-flex items-center gap-0.5 font-mono">
                        PR #{t.pr} <ArrowUpRight className="size-3" aria-hidden="true" />
                      </span>
                    )}
                    <PreviewBadge state={t.preview_state} />
                    {t.updated_at && <RelTime iso={t.updated_at} now={now} className="ml-auto shrink-0" />}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {assets.length > 0 && (
        <div>
          <h3 className="flex items-baseline gap-2 text-xs text-muted-foreground">
            Assets <span className="font-mono tabular-nums">{assets.length}</span>
            <Link href="/assets?status=pending" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
              All pending <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          </h3>
          <ul className="mt-1.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shownAssets.map((a) => (
              <li key={a.id}>
                <Link href={`/assets/${a.id}`} className="flex items-center gap-3 rounded-md border bg-card p-2 transition-colors hover:border-primary/50">
                  <Thumb asset={a} className="size-12 shrink-0 rounded-sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{a.title}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {a.project && <span>{a.project}</span>}
                      {(a.pr ?? a.issue) && <span className="font-mono">#{a.pr ?? a.issue}</span>}
                      <span className="font-mono">v{a.version}</span>
                      <RelTime iso={a.created_at} now={now} className="ml-auto" />
                    </span>
                    <span className="mt-1 block">
                      <ActorChip actor={a.created_by} className="text-muted-foreground" />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
