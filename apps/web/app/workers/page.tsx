import type { Metadata } from "next";
import { Circle, Pause, Power, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { getWorkers } from "@/lib/data";
import type { WorkerStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Workers",
  description: "The machines running relay work: their lanes, what they are on, and when they last checked in.",
  alternates: { canonical: "/workers" },
};

export const dynamic = "force-dynamic";

/** A worker's status mapped to {icon, tone, label, hint}; the rendering is components/ui/status-badge.tsx. */
const STATUS: Record<WorkerStatus, { label: string; tone: StatusTone; icon: LucideIcon; hint: string }> = {
  online: { label: "online", tone: "ok", icon: Circle, hint: "Heartbeat in the last 2 minutes: running a task, or just checked the queue." },
  idle: { label: "idle", tone: "muted", icon: Pause, hint: "Heartbeat under an hour ago. An empty queue slows the worker's check-ins to one every 5 minutes, so this is the normal state of a worker with nothing to do." },
  offline: { label: "offline", tone: "bad", icon: Power, hint: "No heartbeat for over an hour, or the worker reported a shutdown. Tasks for its lanes wait." },
};

const fmtInterval = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 1000)}s`);

export default async function WorkersPage() {
  const workers = await getWorkers();
  const now = Date.now();
  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
        <PageIntro doc="/docs/workers">
          Your machines running <code className="rounded bg-muted px-1 font-mono text-xs">relay work</code>: their lanes, what they are on, when they last checked in.
        </PageIntro>
      </section>
      {workers.length === 0 && (
        <EmptyState title="No workers yet" command={`npx @kyleroche/relay setup --site <this site>
npx @kyleroche/relay work --install --yes`}>
          A worker is a machine with your vendor logins running relay work. Join one with these two commands; it appears here on its first heartbeat.
        </EmptyState>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {workers.map((w) => {
          const s = STATUS[w.status];
          return (
            <li key={w.name} className="flex flex-col gap-3 rounded-md border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-medium">{w.name}</h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {w.host}
                    {w.version ? <span className="ml-2 text-[11px]">relay {w.version}</span> : null}
                  </p>
                </div>
                <StatusBadge icon={s.icon} tone={s.tone} label={s.label} title={s.hint} iconClassName={cn("size-2.5", w.status === "online" && "fill-current")} />
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-[11px] text-muted-foreground">Last seen</dt>
                  <dd>
                    <RelTime iso={w.lastSeen} now={now} />
                  </dd>
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
                    <span className="ml-1 text-xs text-muted-foreground">
                      since <RelTime iso={w.current.startedAt} now={now} />
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {w.status === "offline" ? "unreachable" : "waiting for a task"}
                    {w.status !== "offline" && w.pollMs ? <span className="ml-1 font-mono text-[11px]">(checks every {fmtInterval(w.pollMs)})</span> : null}
                  </p>
                )}
              </div>
              <ul className="flex flex-wrap gap-1" aria-label="Lanes and labels">
                {w.lanes.map((l) => (
                  <Pill key={`lane:${l}`} asChild tone="primary" mono title={`Serves the ${l} lane`}>
                    <li>{l}</li>
                  </Pill>
                ))}
                {w.labels.map((l) =>
                  l === "sandbox:off" ? (
                    // relay work --no-sandbox: this machine runs the Claude lane's Bash without Claude Code's OS sandbox
                    <Pill key={`label:${l}`} asChild tone="bad" mono title="Started with --no-sandbox: the Claude lane's Bash runs without Claude Code's OS sandbox on this machine">
                      <li>{l}</li>
                    </Pill>
                  ) : (
                    <Pill key={`label:${l}`} asChild mono>
                      <li>{l}</li>
                    </Pill>
                  ),
                )}
              </ul>
            </li>
          );
        })}
      </ul>
    </>
  );
}
