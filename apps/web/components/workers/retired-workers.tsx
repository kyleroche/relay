import { Disclosure } from "@/components/ui/collapsible";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import type { board } from "@relay/core";

/** Workers offline for more than 7 days: folded under "Show N retired", one line each. */
export function RetiredWorkers({ workers, now }: { workers: board.WorkerView[]; now: number }) {
  return (
    <Disclosure label={`${workers.length} retired`} className="mt-6">
      <p className="mb-2 text-xs text-muted-foreground">Offline for more than 7 days: a renamed machine, one that moved to the container tier, or one that is gone. Past runs stay in their tasks' threads and in the feed; relay work forget &lt;name&gt; removes one from this list.</p>
      <ul className="divide-y rounded-lg border">
        {workers.map((w) => (
          <li key={w.id} className="px-3 py-2.5 opacity-70">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">{w.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{w.host}</span>
              {w.lanes.map((l) => (
                <Pill key={l} mono>
                  {l}
                </Pill>
              ))}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              last seen <RelTime iso={w.last_seen} now={now} />
              {w.version ? ` · relay ${w.version}` : null}
            </p>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
