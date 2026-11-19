import { ArrowUpRight, Cpu } from "lucide-react";
import Link from "next/link";
import { board } from "@relay/core";
import { CloseAction } from "@/components/tasks/close-action";
import { ReleaseAction } from "@/components/tasks/release-action";
import { RequeueAction } from "@/components/tasks/requeue-action";
import { ReviewActions } from "@/components/tasks/review-actions";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { BUILTIN_LANES, workerOfClaim } from "@/lib/board-read";
import { claimProfile, COLUMNS, columnOf, decisionsFor, evalWait, taskPagePath, TONE_TEXT } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * The board: one column per step a task can be at, cards for the tasks there, the decision a card waits for as buttons
 * on the card itself (the same client components and server actions as the task page, so a decision is the same
 * wherever it was made). The cards are the tasks of the team's Vercel Board, read as they are (lib/board-read.ts);
 * `columnOf` (lib/tasks.ts) puts each of relay's nine states in one of six columns. Held and Failed appear only when
 * they hold something, Held first because a person should read those before anything else; Queue, Running, Review and
 * Done are always there so an empty board still says what the steps are. Each column shows its newest `cap` cards;
 * "Show N more" (`?all=<column>`) opens the whole column in place, keeping the project filter. Done ends in a link to
 * the history, where every task is. DESIGN.md, "Board".
 */

type Task = board.BoardTask;

/** Why a card is where it is, when its state alone does not say: what it waits on, why it is held, how it failed. */
function Why({ t }: { t: Task }) {
  const waits = evalWait(t);
  if (t.state === "waiting")
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        Waits for{" "}
        {t.needs.map((id, i) => (
          <span key={id}>
            {i > 0 && ", "}
            <Link href={taskPagePath(id)} className="font-mono hover:text-primary">
              {id}
            </Link>
          </span>
        ))}
        .
      </p>
    );
  if (t.state === "held") return <p className="mt-1.5 line-clamp-3 text-xs text-warn">Stopped by the injection gate{t.hold?.reason ? `: ${t.hold.reason}` : ""}. Read the task on its page before releasing it.</p>;
  if (waits)
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        The <span className="font-mono">{waits.step}</span> step on the <span className="font-mono">{waits.lane}</span> lane is looking at it (
        <Link href={taskPagePath(waits.task)} className="font-mono hover:text-primary">
          {waits.task}
        </Link>
        ); it comes to you after.
      </p>
    );
  if (t.state === "blocked") return <p className="mt-1.5 line-clamp-3 text-xs text-warn">Held{t.hold?.kind ? ` (${t.hold.kind})` : ""}{t.hold?.reason ? `: ${t.hold.reason}` : "."}</p>;
  if (t.state === "failed" && t.reason) return <p className="mt-1.5 line-clamp-2 text-xs text-bad">{t.reason}</p>;
  if (t.state === "closed" && t.reason) return <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">Closed: {t.reason}</p>;
  if (t.state === "review" && !t.pr) return <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{t.hold?.reason || "Outputs attached"}: look at them on the task&apos;s page.</p>;
  return null;
}

function Card({ t, now, workers, canWrite, servedLanes }: { t: Task; now: number; workers: readonly board.WorkerView[]; canWrite: boolean; servedLanes: readonly string[] }) {
  const can = decisionsFor(t.state);
  const worker = workerOfClaim(workers, t.claim);
  return (
    <li className="rounded-md border bg-card p-3 text-sm">
      <Link href={taskPagePath(t.id)} className="line-clamp-2 font-medium leading-snug hover:text-primary">
        {t.title || t.id}
      </Link>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{t.project ?? t.channel}</span>
        {t.lane ? (
          <Pill mono size="sm">
            {t.lane}
          </Pill>
        ) : (
          // a finished task has given its lane up; only one still to be run is missing something
          (can.requeue || t.state === "running") && <span>no lane</span>
        )}
        {t.model && <span className="font-mono">{t.model}</span>}
        <RelTime iso={t.created_at} now={now} />
      </p>
      {t.state === "running" && t.claim && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground" title={worker ? `${worker.name}: ${worker.state}` : t.claim.actor}>
          <Cpu className="size-3" aria-hidden="true" />
          <Link href="/workers" className="hover:text-foreground">
            {worker?.name ?? claimProfile(t.claim.actor)}
          </Link>
          {worker && worker.state !== "online" && <span className="text-warn">{worker.state}</span>}
        </p>
      )}
      <Why t={t} />
      {t.pr && (
        <p className="mt-1.5 text-xs">
          <a href={t.pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-muted-foreground hover:text-primary">
            PR #{t.pr.number} <ArrowUpRight className="size-3" aria-hidden="true" />
          </a>
        </p>
      )}
      {(can.review || can.release || can.requeue || can.close) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          {can.review && <ReviewActions taskId={t.id} pr={t.pr?.number ?? null} canWrite={canWrite} size="sm" />}
          {can.release && <ReleaseAction taskId={t.id} canWrite={canWrite} size="sm" />}
          {can.requeue && <RequeueAction taskId={t.id} lane={t.lane} model={t.model} state={t.state} builtinLanes={BUILTIN_LANES} servedLanes={servedLanes} canWrite={canWrite} size="sm" />}
          {can.close && <CloseAction taskId={t.id} state={t.state} pr={t.pr?.number ?? null} canWrite={canWrite} size="sm" />}
        </div>
      )}
    </li>
  );
}

export function Board({ tasks, workers, now, canWrite, all, project }: { tasks: Task[]; workers: readonly board.WorkerView[]; now: number; canWrite: boolean; all?: string; project?: string }) {
  const servedLanes = board.servedLanes([...workers]);
  const columns = COLUMNS.map((c) => ({ ...c, list: tasks.filter((t) => columnOf(t) === c.key) })).filter((c) => c.always || c.list.length > 0);
  const href = (column?: string) => {
    const qs = new URLSearchParams();
    if (project) qs.set("project", project);
    if (column) qs.set("all", column);
    const s = qs.toString();
    return s ? `/?${s}` : "/";
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none" aria-label="Board">
      {columns.map((c) => {
        const shown = all === c.key ? c.list : c.list.slice(0, c.cap);
        const more = c.list.length - shown.length;
        return (
          <section key={c.key} aria-labelledby={`col-${c.key}`} className="flex min-w-0 flex-col rounded-lg border bg-muted/30">
            <h2 id={`col-${c.key}`} className="flex items-baseline gap-2 px-3 py-2 text-xs font-medium" title={c.hint}>
              <span className={cn(TONE_TEXT[c.tone])}>{c.label}</span>
              <span className="font-mono tabular-nums text-foreground">{c.list.length}</span>
            </h2>
            {shown.length === 0 ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground">{c.key === "done" ? "Nothing merged or approved yet." : "Nothing here."}</p>
            ) : (
              <ul className="flex flex-col gap-2 px-2 pb-2">
                {shown.map((t) => (
                  <Card key={t.id} t={t} now={now} workers={workers} canWrite={canWrite} servedLanes={servedLanes} />
                ))}
              </ul>
            )}
            {more > 0 && (
              <Link href={href(c.key)} scroll={false} className="px-3 pb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Show {more} more
              </Link>
            )}
            {all === c.key && c.list.length > c.cap && (
              <Link href={href()} scroll={false} className="px-3 pb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Show fewer
              </Link>
            )}
            {c.key === "done" && (
              <Link href={`/history${project ? `?project=${encodeURIComponent(project)}` : ""}`} className="px-3 pb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Every task, in History →
              </Link>
            )}
          </section>
        );
      })}
    </div>
  );
}
