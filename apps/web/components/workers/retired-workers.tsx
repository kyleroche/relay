"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { forgetWorkerAction, type WorkerActionResult } from "@/app/workers/actions";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/collapsible";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import type { Worker } from "@/lib/types";

/**
 * Workers offline for more than 7 days (docs/WORKERS.md, "Retiring a worker"): folded under "Show N retired", one
 * line each with a Forget button. Forgetting is one click, no confirm: it only removes the row, past runs stay, and a
 * machine that is still running `relay work` registers itself again on its next heartbeat.
 */
export function RetiredWorkers({ workers, canWrite, now }: { workers: Worker[]; canWrite: boolean; now: number }) {
  const router = useRouter();
  const [result, setResult] = useState<WorkerActionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const forget = (name: string) => {
    if (pending) return;
    setBusy(name);
    start(async () => {
      const r = await forgetWorkerAction(name);
      setResult(r.ok ? null : r);
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <Disclosure label={`${workers.length} retired`} className="mt-6">
      <p className="mb-2 text-xs text-muted-foreground">
        Offline for more than 7 days: a renamed machine, one that moved to the container tier, or one that is gone. Forget removes the row; past runs stay in the feed, and a machine that still runs{" "}
        <code className="rounded bg-muted px-1 font-mono text-[11px]">relay work</code> registers itself again on its next heartbeat. The same from a terminal:{" "}
        <code className="rounded bg-muted px-1 font-mono text-[11px]">relay work forget &lt;name&gt;</code>.
      </p>
      {result && !result.ok && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {result.message}
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {workers.map((w) => (
          <li key={w.name} className="flex flex-col gap-2 px-3 py-2.5 opacity-70 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
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
                last seen <RelTime iso={w.lastSeen} now={now} />
                {w.version ? ` · relay ${w.version}` : null}
              </p>
            </div>
            <Button size="sm" variant="ghost" className="hover:text-destructive" onClick={() => forget(w.name)} disabled={!canWrite || pending} aria-label={`Forget ${w.name}`} title={canWrite ? "Remove this worker from the list" : "Needs a database; the deployment runs on demo data"}>
              <Trash2 className="size-3.5" /> {busy === w.name ? "Forgetting…" : "Forget"}
            </Button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
