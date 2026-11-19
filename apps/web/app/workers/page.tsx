import type { Metadata } from "next";
import { Circle, Pause, Power, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { board } from "@relay/core";
import { Alert } from "@/components/alert";
import { PageIntro } from "@/components/page-intro";
import { RetiredWorkers } from "@/components/workers/retired-workers";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { boardProblem } from "@/lib/board";
import { fleet, type FleetWorker } from "@/lib/board-read";
import { fmtPercent } from "@/lib/format";
import { taskPagePath } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Workers",
  description: "The machines running relay work: their lanes, what they are on, and when they last checked in.",
  alternates: { canonical: "/workers" },
};

export const dynamic = "force-dynamic";

/** A worker's state mapped to {icon, tone, label, hint}; the rendering is components/ui/status-badge.tsx. */
const STATUS: Record<board.WorkerState, { label: string; tone: StatusTone; icon: LucideIcon; hint: string }> = {
  online: { label: "online", tone: "ok", icon: Circle, hint: "Seen in the last 12 minutes: running a task, or waiting on the board for one." },
  idle: { label: "idle", tone: "muted", icon: Pause, hint: "Seen under an hour ago. A worker with nothing to take waits on the board and checks in every few minutes, so this is a normal state." },
  offline: { label: "offline", tone: "bad", icon: Power, hint: "Silent for over an hour, or stopped cleanly. Tasks for its lanes wait. After 7 days offline the worker is retired: folded away below." },
};

/**
 * The fleet, read from the team's Vercel Board: every worker keeps one message in `relay/workers` (its lanes, labels,
 * version and the plan meters its logins report), and the tasks it holds are the running ones its lanes claimed.
 */
export default async function WorkersPage() {
  const read = await fleet().then(
    (all) => ({ all, problem: null }),
    (e: unknown) => ({ all: [] as FleetWorker[], problem: boardProblem(e) }),
  );
  const { all } = read;
  const now = Date.now();
  // offline for more than 7 days: a renamed or decommissioned machine; folded away
  const workers = all.filter((w) => !w.retired);
  const retired = all.filter((w) => w.retired);
  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
        <PageIntro doc="/docs/workers">
          Your machines running <code className="rounded bg-muted px-1 font-mono text-xs">relay work</code>: their lanes, what they are on, when they last checked in.
        </PageIntro>
      </section>
      {read.problem && <Alert tone="bad">The board could not be read. {read.problem}</Alert>}
      {!read.problem && all.length === 0 && (
        <EmptyState title="No workers yet" command={`vercel login
npx @kyleroche/relay setup --board
npx @kyleroche/relay work --install --yes`}>
          A worker is a machine with your vendor logins running relay work. It claims tasks from the team&apos;s Vercel Board under its own Vercel login and appears here with its first sign of life.
        </EmptyState>
      )}
      {all.length > 0 && workers.length === 0 && <p className="text-sm text-muted-foreground">No active workers: every machine on the board has been offline for more than 7 days. Tasks wait until one runs relay work again.</p>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {workers.map((w) => {
          const s = STATUS[w.state];
          return (
            <li key={w.id} className="flex flex-col gap-3 rounded-md border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-medium">{w.name}</h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {w.host}
                    {w.version ? <span className="ml-2 text-[11px]">relay {w.version}</span> : null}
                  </p>
                </div>
                <StatusBadge icon={s.icon} tone={s.tone} label={s.label} title={s.hint} iconClassName={cn("size-2.5", w.state === "online" && "fill-current")} />
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-[11px] text-muted-foreground">Last seen</dt>
                  <dd>
                    <RelTime iso={w.last_seen} now={now} />
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Running</dt>
                  <dd className="font-mono tabular-nums">{w.state === "offline" ? 0 : w.running}</dd>
                </div>
              </dl>
              <div>
                <p className="text-[11px] text-muted-foreground">Now</p>
                {w.current.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 text-sm">
                    {w.current.map((t) => (
                      <li key={t.id} className="flex min-w-0 items-baseline gap-2">
                        <Link href={taskPagePath(t.id)} className="truncate text-primary underline underline-offset-4">
                          {t.title || t.id}
                        </Link>
                        {t.lane && <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.lane}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{w.state === "offline" ? "unreachable" : "waiting on the board for a task"}</p>
                )}
              </div>
              {w.meters.length > 0 && (
                <div>
                  <p className="text-[11px] text-muted-foreground">Plan meters it reports</p>
                  <p className="flex flex-wrap gap-x-3 font-mono text-xs tabular-nums">
                    {w.meters.map((m) => (
                      <span key={`${m.subscription}:${m.window}`} title={`captured ${m.captured_at}`}>
                        {m.subscription} {m.window} {fmtPercent(m.used_percentage)}
                      </span>
                    ))}
                  </p>
                </div>
              )}
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
      {retired.length > 0 && <RetiredWorkers workers={retired} now={now} />}
    </>
  );
}
