import { ArrowUpRight, Cpu } from "lucide-react";
import Link from "next/link";
import { CLOUD_LANES, WORKER_LANES, type TaskState } from "@relay/core";
import { Thumb } from "@/components/assets/asset-card";
import { AssetReviewActions } from "@/components/assets/asset-review-actions";
import { ReleaseAction } from "@/components/tasks/release-action";
import { RequeueAction } from "@/components/tasks/requeue-action";
import { ReviewActions } from "@/components/tasks/review-actions";
import { PreviewBadge } from "@/components/tasks/state-badge";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { STATE_HINT, STATE_TONE, taskPagePath, TONE_TEXT } from "@/lib/tasks";
import type { AssetKind, BoardTask, Worker } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The board: one column per step a task can be at, cards for the tasks there, the decision a card waits for as buttons
 * on the card itself (the same client components and server actions as the task page, so the feed row is the same
 * whoever decided and wherever). Held and Failed appear only when they hold something, Held first because the gate
 * stopped those and a person should read them before anything else; Queue, Running, Review and Done are always there
 * so an empty board still says what the steps are. The cards come from one query over the task state cache
 * (`boardTasks`), not a fold per task. Each column shows its newest `cap` cards; "Show N more" (`?all=<column>`)
 * opens the whole column in place, keeping the project filter. A card whose deliverable is an asset (a production)
 * shows the asset's thumbnail and kind where a PR card shows its PR line, and Approve / Reject with a note in Review
 * instead of Approve-and-merge. DESIGN.md, "Board".
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

/** The asset a task delivered: its thumbnail (or the kind's icon when the store rendered none, as for audio), kind, version and a link to the library. */
function AssetLine({ t, title }: { t: BoardTask & { asset_id: string }; title: string }) {
  const kind = (t.asset_kind ?? "file") as AssetKind;
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <Link href={`/assets/${t.asset_id}`} className="shrink-0 overflow-hidden rounded border hover:border-primary/50" aria-label={`Open ${title} in the asset library`}>
        <Thumb asset={{ thumb_url: t.asset_thumb_url, kind, title, url: null }} className="h-14 w-[5.6rem]" />
      </Link>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Pill size="sm">{kind}</Pill>
        {t.asset_version != null && <span className="font-mono">v{t.asset_version}</span>}
        <Link href={`/assets/${t.asset_id}`} className="inline-flex items-center gap-0.5 hover:text-primary">
          Open <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}

function Card({ t, now, workers, canWrite, registeredLanes }: { t: BoardTask; now: number; workers: Worker[]; canWrite: boolean; registeredLanes: readonly string[] }) {
  const title = t.title ?? `#${t.issue}`;
  const inFlight = t.state === "claimed" || t.state === "running";
  const name = workerName(t.runner);
  const worker = name ? workers.find((w) => w.name === name) : undefined;
  const requeue = t.state !== "done";
  const asset = t.asset_id != null;
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
        {t.since && <RelTime iso={t.since} now={now} />}
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
      {t.state === "failed" && t.last_error && <p className="mt-1.5 line-clamp-2 text-xs text-bad">{t.last_error}</p>}
      {t.asset_id != null && <AssetLine t={{ ...t, asset_id: t.asset_id }} title={title} />}
      {!asset && (t.pr || t.preview_url || t.preview_state !== "none") && (
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
          {t.state === "review" && (t.asset_id != null ? <AssetReviewActions assetId={t.asset_id} version={t.asset_version} canWrite={canWrite} size="sm" /> : <ReviewActions taskId={t.id} pr={t.pr} canWrite={canWrite} size="sm" />)}
          {t.state === "held" && <ReleaseAction taskId={t.id} canWrite={canWrite} size="sm" />}
          {requeue && <RequeueAction taskId={t.id} lane={t.lane} state={t.state} workerLanes={WORKER_LANES} registeredLanes={registeredLanes} cloudLanes={CLOUD_LANES} canWrite={canWrite} size="sm" />}
        </div>
      )}
    </li>
  );
}

export function Board({ tasks, workers, now, canWrite, all, project, registeredLanes = [] }: { tasks: BoardTask[]; workers: Worker[]; now: number; canWrite: boolean; all?: string; project?: string; registeredLanes?: readonly string[] }) {
  const columns = COLUMNS.map((c) => ({ ...c, list: tasks.filter((t) => c.states.includes(t.state)) })).filter((c) => c.always || c.list.length > 0);
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
              <p className="px-3 pb-3 text-xs text-muted-foreground">{c.key === "done" ? "Nothing merged or approved yet." : "Nothing here."}</p>
            ) : (
              <ul className="flex flex-col gap-2 px-2 pb-2">
                {shown.map((t) => (
                  <Card key={t.id} t={t} now={now} workers={workers} canWrite={canWrite} registeredLanes={registeredLanes} />
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
          </section>
        );
      })}
    </div>
  );
}
