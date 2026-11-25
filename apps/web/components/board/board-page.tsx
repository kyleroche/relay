import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { board } from "@relay/core";
import { AutoRefresh } from "@/components/board/auto-refresh";
import { Board } from "@/components/board/board";
import { ProjectFilter } from "@/components/board/project-filter";
import { DemoNotice } from "@/components/demo-notice";
import { HomeTabs } from "@/components/home-tabs";
import { ReviewPrompt } from "@/components/tasks/review-prompt";
import { EmptyState } from "@/components/ui/empty-state";
import { boardProblem, siteBoard, siteWorkers } from "@/lib/board";
import { newestFinished, openTasks } from "@/lib/board-read";
import { syncFeedAfter } from "@/lib/board-watch";
import { cloudViews } from "@/lib/cloud/view";
import { dataMode, getAssets, getProjects } from "@/lib/data";
import { REVIEW_AGENT_PROMPT } from "@/lib/tasks";

/** The board: what a signed-in viewer sees at /. `app/page.tsx` picks between this and the public landing. */

export const BOARD_METADATA: Metadata = {
  title: { absolute: "relay — board of what your coding agents are doing" },
  description: "Every task across your coding-agent subscriptions by step: queued, running on a worker, waiting for your review, merged. Approve, send back or requeue from the card.",
  alternates: { canonical: "/" },
};

/** The newest finished tasks the board keeps; History has the rest. */
const DONE_SHOWN = 10;

export async function BoardPage({ all, project }: { all?: string; project?: string } = {}) {
  const db = dataMode() === "db";
  syncFeedAfter(siteBoard);
  const [read, pending, projects] = await Promise.all([
    Promise.all([openTasks(project), newestFinished(DONE_SHOWN, project), siteWorkers(), siteBoard()]).then(
      async ([open, finished, workers, session]) => ({
        tasks: [...open, ...finished],
        workers,
        problem: null,
        decides: board.mayIn(session.me.can, board.workChannel("any"), "manage"),
        // the offer of a paid run on a queued card: read from the board as it is now, and nothing is written to make it
        cloud: await cloudViews(open, { session, workers, now: Date.now() }).catch(() => new Map()),
      }),
      (e: unknown) => ({ tasks: [], workers: [], problem: boardProblem(e), decides: true, cloud: new Map() }),
    ),
    getAssets({ status: "pending", limit: 50, ...(project ? { project } : {}) }),
    getProjects(),
  ]);
  const now = Date.now();
  const tasks = read.tasks;
  const live = read.workers.filter((w) => !w.retired);
  const online = live.filter((w) => w.state !== "offline").length;
  const offline = live.length - online;
  const waiting = tasks.filter((t) => t.state === "review" || t.state === "held").length;
  const moving = tasks.filter((t) => t.state === "waiting" || t.state === "queued" || t.state === "running" || t.state === "blocked").length;
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
              Every task is a thread in its project&apos;s queue on the team&apos;s Vercel Board; the column is its state there. Decide on the card: approve merges the pull request, accepts the outputs or opens a proposed plan&apos;s tasks, request changes sends it back with your note, release lifts the gate&apos;s hold, close finishes it without a merge. Done keeps the newest ten; History has the rest. The board refreshes itself.
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
      {read.problem && (
        <Alert tone="bad" className="mb-4">
          The board could not be read. {read.problem}
        </Alert>
      )}
      {db && !read.problem && !read.decides && (
        <Alert tone="warn" className="mb-4">
          This deployment can open tasks but does not manage the queues (<code>work/</code>) on the board, so it cannot approve, release, requeue or close a task someone else opened. Someone who manages the board runs <code>relay setup --board --site-project &lt;this project&gt;</code> once.
        </Alert>
      )}
      {db && !read.problem && read.tasks.length === 0 && !project && (
        <EmptyState title="No tasks yet" command={`relay task create --title "…" --lane claude`} className="mb-4">
          A task is a thread in a project&apos;s queue on the board. Open one with the command, the relay_task_create tool, or by labelling a GitHub issue agent:&lt;lane&gt;; it appears in Queue here.
        </EmptyState>
      )}
      {!read.problem && read.tasks.length === 0 && project && (
        <EmptyState title={known ? `No tasks in ${project}` : `No project ${project}`} command={known ? `relay task create --project ${project} --title "…" --lane claude` : `relay project add ${project} --repo owner/name`} className="mb-4">
          {known ? "This project's queue is empty. Open a task with the command, or pick another project above." : "Register the project first; it then appears in the filter above."}
        </EmptyState>
      )}
      <Board tasks={tasks} workers={live} now={now} canWrite={db} all={all} project={project} cloud={read.cloud} />
    </>
  );
}
