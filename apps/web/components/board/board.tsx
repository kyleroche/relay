import { ArrowUpRight, Cpu } from "lucide-react";
import Link from "next/link";
import { CLOUD_LANES, WORKER_LANES, type TaskState, type TaskView } from "@relay/core";
import { ReleaseAction } from "@/components/tasks/release-action";
import { RequeueAction } from "@/components/tasks/requeue-action";
import { ReviewActions } from "@/components/tasks/review-actions";
import { PreviewBadge } from "@/components/tasks/state-badge";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { STATE_HINT, STATE_TONE, taskPagePath, TONE_TEXT } from "@/lib/tasks";
import type { Worker } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The board: one column per step a task can be at, cards for the tasks there, the decision a card waits for as buttons
 * on the card itself (the same client components and server actions as the task page, so the feed row is the same
 * whoever decided and wherever). Held and Failed appear only when they hold something, Held first because the gate
 * stopped those and a person should read them before anything else; Queue, Running, Review and Done are always there
 * so an empty board still says what the steps are. Each column shows its newest `cap` cards; "Show N more" (`?all=<column>`)
 * opens the whole column in place. DESIGN.md, "Board".
 */

interface Column {
  key: string;
  label: string;
  states: readonly TaskState[];
  /** Drawn even when empty. */
  always: boolean;
  cap: number;
}

const COLUMNS: readonly Column[] = [
  { key: "held", label: "Held", states: ["held"], always: false, cap: 25 },
  { key: "queued", label: "Queue", states: ["queued"], always: true, cap: 25 },
  { key: "running", label: "Running", states: ["claimed", "running"], always: true, cap: 25 },
  { key: "review", label: "Review", states: ["review"], always: true, cap: 25 },
  { key: "failed", label: "Failed", states: ["failed"], always: false, cap: 10 },
  { key: "done", label: "Done", states: ["done"], always: true, cap: 10 },
];

const workerName = (runner: string | null): string | null => (runner ? runner.replace(/^runner:/, "") : null);

function Card({ t, now, workers, canWrite }: { t: TaskView; now: number; workers: Worker[]; canWrite: boolean }) {
  const title = t.title ?? t.run_summary ?? t.summary ?? t.id;
  const inFlight = t.state === "claimed" || t.state === "running";
  const name = workerName(t.runner);
  const worker = name ? workers.find((w) => w.name === name) : undefined;
  const requeue = t.state !== "done";
  return (
    <li className="rounded-md border bg-card p-3 text-sm">
      <Link href={taskPagePath(t)} className="line-clamp-2 font-medium leading-snug hover:text-primary">
        {title}
      </Link>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{t.id}</span>
        {t.lane ? (
          <Pill mono size="sm">
            {t.lane}
          </Pill>
        ) : (
          <span>no lane</span>
        )}
        {t.updated_at && <RelTime iso={t.updated_at} now={now} />}
      </p>
      {inFlight && name && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground" title={worker ? `${name}: ${worker.status}` : name}>
          <Cpu className="size-3" aria-hidden="true" />
          <Link href="/workers" className="hover:text-foreground">
            {name}
          </Link>
          {worker && worker.status !== "online" && <span className="text-warn">{worker.status}</span>}
        </p>
      )}
      {t.state === "held" && <p className="mt-1.5 text-xs text-warn">Stopped by the injection gate. Read the issue on its page before releasing it.</p>}
      {t.state === "failed" && t.run_summary && <p className="mt-1.5 line-clamp-2 text-xs text-bad">{t.run_summary}</p>}
      {(t.pr || t.preview_url || t.preview_state !== "none") && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {t.pr && (
            <a href={t.pr_url ?? "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-muted-foreground hover:text-primary">
              PR #{t.pr} <ArrowUpRight className="size-3" aria-hidden="true" />
            </a>
          )}
          {t.preview_url ? (
            <a href={t.preview_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-primary" title="Open the preview">
              <PreviewBadge state={t.preview_state} />
              <ArrowUpRight className="size-3" aria-hidden="true" />
            </a>
          ) : (
            t.preview_state !== "none" && <PreviewBadge state={t.preview_state} />
          )}
        </p>
      )}
      {(t.state === "review" || t.state === "held" || requeue) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          {t.state === "review" && <ReviewActions taskId={t.id} pr={t.pr} canWrite={canWrite} size="sm" />}
          {t.state === "held" && <ReleaseAction taskId={t.id} canWrite={canWrite} size="sm" />}
          {requeue && <RequeueAction taskId={t.id} lane={t.lane} state={t.state} workerLanes={WORKER_LANES} cloudLanes={CLOUD_LANES} canWrite={canWrite} size="sm" />}
        </div>
      )}
    </li>
  );
}

export function Board({ tasks, workers, now, canWrite, all }: { tasks: TaskView[]; workers: Worker[]; now: number; canWrite: boolean; all?: string }) {
  const columns = COLUMNS.map((c) => ({ ...c, list: tasks.filter((t) => c.states.includes(t.state)) })).filter((c) => c.always || c.list.length > 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none" aria-label="Board">
      {columns.map((c) => {
        const tone = STATE_TONE[c.states[0]!];
        const shown = all === c.key ? c.list : c.list.slice(0, c.cap);
        const more = c.list.length - shown.length;
        return (
          <section key={c.key} aria-labelledby={`col-${c.key}`} className="flex min-w-0 flex-col rounded-lg border bg-muted/30">
            <h2 id={`col-${c.key}`} className="flex items-baseline gap-2 px-3 py-2 text-xs font-medium" title={STATE_HINT[c.states[0]!]}>
              <span className={cn(TONE_TEXT[tone])}>{c.label}</span>
              <span className="font-mono tabular-nums text-foreground">{c.list.length}</span>
            </h2>
            {shown.length === 0 ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground">{c.key === "done" ? "Nothing merged yet." : "Nothing here."}</p>
            ) : (
              <ul className="flex flex-col gap-2 px-2 pb-2">
                {shown.map((t) => (
                  <Card key={t.id} t={t} now={now} workers={workers} canWrite={canWrite} />
                ))}
              </ul>
            )}
            {more > 0 && (
              <Link href={`/?all=${c.key}`} scroll={false} className="px-3 pb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Show {more} more
              </Link>
            )}
            {all === c.key && c.list.length > c.cap && (
              <Link href="/" scroll={false} className="px-3 pb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Show fewer
              </Link>
            )}
          </section>
        );
      })}
    </div>
  );
}
