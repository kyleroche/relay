import type { Metadata } from "next";
import { Circle, Pause, Power } from "lucide-react";
import Link from "next/link";
import { getWorkers } from "@/lib/data";
import { fmtAgo } from "@/lib/format";
import type { WorkerStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Workers",
  description: "Health of the self-hosted runners that execute relay lanes on your own machines.",
  alternates: { canonical: "/workers" },
};

export const dynamic = "force-dynamic";

const STATUS: Record<WorkerStatus, { label: string; className: string; Icon: typeof Circle; hint: string }> = {
  online: { label: "online", className: "text-ok", Icon: Circle, hint: "Heartbeat in the last 5 minutes." },
  idle: { label: "idle", className: "text-muted-foreground", Icon: Pause, hint: "Registered and reachable, no job claimed recently." },
  offline: { label: "offline", className: "text-bad", Icon: Power, hint: "No heartbeat for over an hour. Jobs with its labels wait." },
};

export default async function WorkersPage() {
  const workers = await getWorkers();
  const now = Date.now();
  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Self-hosted GitHub Actions runners on machines you own. Each holds its own vendor logins; a job only runs where its
          <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">agent:*</code>label matches a runner label. Nothing here is
          configured from the web: register runners with the vendor CLI logged in, as described in the docs.
        </p>
      </section>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {workers.map((w) => {
          const s = STATUS[w.status];
          return (
            <li key={w.name} className="flex flex-col gap-3 rounded-md border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-medium">{w.name}</h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">{w.host}</p>
                </div>
                <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", s.className)} title={s.hint}>
                  <s.Icon className={cn("size-2.5", w.status === "online" && "fill-current")} aria-hidden="true" />
                  {s.label}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-[11px] text-muted-foreground">Last seen</dt>
                  <dd className="font-mono tabular-nums">{fmtAgo(w.lastSeen, now)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Runs today</dt>
                  <dd className="font-mono tabular-nums">{w.runsToday}</dd>
                </div>
              </dl>
              <div>
                <p className="text-[11px] text-muted-foreground">Now</p>
                {w.current ? (
                  <p className="text-sm">
                    <Link href={`/projects/${w.current.project}`} className="text-primary underline underline-offset-4">
                      {w.current.project}
                    </Link>{" "}
                    <span className="font-mono text-xs">#{w.current.issue}</span>
                    <span className="ml-1 font-mono text-[11px] text-muted-foreground">since {fmtAgo(w.current.startedAt, now)}</span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">{w.status === "offline" ? "unreachable" : "waiting for a job"}</p>
                )}
              </div>
              <ul className="flex flex-wrap gap-1" aria-label="Runner labels">
                {w.labels.map((l) => (
                  <li key={l} className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", l.startsWith("agent:") ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                    {l}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      <section className="mt-10 max-w-2xl">
        <h2 className="text-lg font-semibold tracking-tight">How status is derived</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
          {(Object.keys(STATUS) as WorkerStatus[]).map((k) => (
            <li key={k} className="flex gap-2">
              <span className={cn("w-14 shrink-0 font-mono text-xs", STATUS[k].className)}>{STATUS[k].label}</span>
              <span>{STATUS[k].hint}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
