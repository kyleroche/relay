import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/board/auto-refresh";
import { Board } from "@/components/board/board";
import { ProjectFilter } from "@/components/board/project-filter";
import { DemoNotice } from "@/components/demo-notice";
import { HomeTabs } from "@/components/home-tabs";
import { ReviewPrompt } from "@/components/tasks/review-prompt";
import { EmptyState } from "@/components/ui/empty-state";
import { registeredLanes as coreRegisteredLanes } from "@relay/core";
import { dataMode, getAssets, getBoard, getProjects, getWorkers } from "@/lib/data";
import { getDb } from "@/lib/db";
import { REVIEW_AGENT_PROMPT } from "@/lib/tasks";

/** The board: what a signed-in viewer sees at /. `app/page.tsx` picks between this and the public landing. */

export const BOARD_METADATA: Metadata = {
  title: { absolute: "relay — board of what your coding agents are doing" },
  description: "Every task across your coding-agent subscriptions by step: queued, running on a worker, waiting for your review, merged. Approve, send back or requeue from the card.",
  alternates: { canonical: "/" },
};

export async function BoardPage({ all, project }: { all?: string; project?: string } = {}) {
  const db = dataMode() === "db";
  const [tasks, workers, pending, projects, registeredLanes] = await Promise.all([
    getBoard({ limit: 300, doneLimit: 10, ...(project ? { project } : {}) }),
    getWorkers(),
    getAssets({ status: "pending", limit: 50, ...(project ? { project } : {}) }),
    getProjects(),
    // the Requeue sheet's "Registered" lanes: what workers beyond relay work serve (the demo dataset has none)
    db ? getDb().then(coreRegisteredLanes) : Promise.resolve([] as string[]),
  ]);
  const now = Date.now();
  const live = workers.filter((w) => !w.retired);
  const online = live.filter((w) => w.status !== "offline").length;
  const offline = live.length - online;
  const waiting = tasks.filter((t) => t.state === "review" || t.state === "held").length;
  const moving = tasks.filter((t) => t.state === "queued" || t.state === "claimed" || t.state === "running").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const known = project ? projects.some((p) => p.slug === project) : true;

  return (
    <>
      <AutoRefresh />
      <section className="py-6 sm:py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="sr-only">Board</h1>
            <HomeTabs active="board" />
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Every task is a GitHub issue; the column is its state, read from the feed. Decide on the card: approve merges a PR or accepts an asset, request changes or reject sends it back with your note, release lifts a hold. The board refreshes itself.
            </p>
            <ProjectFilter projects={projects} current={project} className="mt-2" />
          </div>
          <div className="flex flex-col items-start gap-3 sm:items-end">
            {db && <ReviewPrompt prompt={REVIEW_AGENT_PROMPT} />}
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">In motion</dt>
                <dd className="font-mono tabular-nums">{plural(moving, "task")}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Waiting on you</dt>
                <dd className="font-mono tabular-nums">
                  {waiting > 0 ? <span className="text-warn">{plural(waiting, "task")}</span> : plural(0, "task")}
                  <span className="text-muted-foreground"> · </span>
                  {pending.length > 0 ? (
                    <Link href={project ? `/assets?status=pending&project=${encodeURIComponent(project)}` : "/assets?status=pending"} className="text-warn underline underline-offset-4">
                      {plural(pending.length, "asset")}
                    </Link>
                  ) : (
                    plural(0, "asset")
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Workers</dt>
                <dd className="font-mono tabular-nums">
                  <Link href="/workers" className={offline > 0 ? "text-warn underline underline-offset-4" : "underline underline-offset-4"}>
                    {online} online{offline > 0 ? `, ${offline} offline` : ""}
                  </Link>
                </dd>
              </div>
            </dl>
          </div>
        </div>
        {!db && <DemoNotice className="mt-3" />}
      </section>
      {db && tasks.length === 0 && !project && (
        <EmptyState title="No tasks yet" command={`relay task create --title "…" --lane claude`} className="mb-4">
          A task is a GitHub issue with an agent:* label. Open one with the command, the relay_task_create tool, or by labelling an issue; it appears in Queue here.
        </EmptyState>
      )}
      {tasks.length === 0 && project && (
        <EmptyState title={known ? `No tasks in ${project}` : `No project ${project}`} command={known ? `relay task create --project ${project} --title "…" --lane claude` : `relay project add ${project} --repo owner/name`} className="mb-4">
          {known ? "Nothing in motion, failed this week or merged for this project. Open a task with the command, or pick another project above." : "Register the project first; it then appears in the filter above."}
        </EmptyState>
      )}
      <Board tasks={tasks} workers={live} now={now} canWrite={db} all={all} project={project} registeredLanes={registeredLanes} />
    </>
  );
}
