import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { repo, type TaskState, type TaskView } from "@relay/core";
import { DemoNotice } from "@/components/demo-notice";
import { PageIntro } from "@/components/page-intro";
import { ReviewPrompt } from "@/components/tasks/review-prompt";
import { PreviewBadge, TaskStateBadge } from "@/components/tasks/state-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { REVIEW_AGENT_PROMPT, STATE_HINT, STATE_TONE, taskPagePath, TONE_TEXT } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Tasks",
  description: "Every task relay knows, with its derived state: what is queued, what a worker is on, what waits for a decision, what shipped.",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/** One task: state, title, where it is (repo#n, lane), what came out (PR, preview), and how long ago it moved. */
function Row({ t, now }: { t: TaskView; now: number }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 sm:items-center">
      <TaskStateBadge state={t.state} className="mt-0.5 w-[5.5rem] justify-start sm:mt-0" />
      <div className="min-w-0 flex-1">
        <Link href={taskPagePath(t)} className="block truncate text-sm font-medium hover:text-primary">
          {t.run_summary ?? t.summary ?? t.id}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{t.id}</span>
          {t.lane ? <Pill mono>{t.lane}</Pill> : <span>no lane</span>}
          {t.pr && (
            <a href={t.pr_url ?? "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-primary">
              PR #{t.pr} <ArrowUpRight className="size-3" aria-hidden="true" />
            </a>
          )}
          {t.preview_url ? (
            <a href={t.preview_url} target="_blank" rel="noopener noreferrer" className="inline-flex">
              <PreviewBadge state={t.preview_state} />
            </a>
          ) : (
            <PreviewBadge state={t.preview_state} />
          )}
        </p>
      </div>
      {t.updated_at && <RelTime iso={t.updated_at} now={now} className="shrink-0 text-xs text-muted-foreground" />}
    </li>
  );
}

/**
 * /tasks: every task with its derived state in one list, the ones waiting for a decision first. A task is a GitHub
 * issue; this page is the read model over the feed (DESIGN.md), and the task page is where a decision is made.
 */
export default async function TasksPage() {
  await requireSession("/tasks");
  const db = dataMode() === "db";
  const tasks = db ? await repo.listTaskViews(await getDb(), { limit: 200 }) : [];
  const now = Date.now();
  const byState = new Map<TaskState, TaskView[]>();
  for (const t of tasks) byState.set(t.state, [...(byState.get(t.state) ?? []), t]);
  // held first: the gate stopped these and a person should read them before anything else waits on a decision
  const order: TaskState[] = ["held", "review", "running", "claimed", "queued", "failed", "done"];
  const groups = order.map((state) => ({ state, list: byState.get(state) ?? [] })).filter((g) => g.list.length > 0);
  return (
    <>
      <section className="py-6 sm:py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
            <PageIntro doc="/docs/workers">The complete list, every task relay knows; the board at / shows the newest per column with the decisions on the cards. Held ones were stopped by the injection gate and wait for you to read them; the ones in review wait for your decision.</PageIntro>
          </div>
          {db && <ReviewPrompt prompt={REVIEW_AGENT_PROMPT} />}
        </div>
        {!db && <DemoNotice className="mt-3" />}
      </section>

      {db && tasks.length === 0 && (
        <EmptyState title="No tasks yet" command={`relay task create --title "…" --lane claude`}>
          A task is a GitHub issue with an agent:* label. Open one with the command, the relay_task_create tool, or by labelling an issue.
        </EmptyState>
      )}
      {groups.length > 0 && (
        <ul className="divide-y rounded-lg border" aria-label="Tasks by state">
          {groups.map(({ state, list }) => (
            <li key={state}>
              <h2 className="flex items-baseline gap-2 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground" title={STATE_HINT[state]}>
                <span className={cn(TONE_TEXT[STATE_TONE[state]])}>{state}</span>
                <span className="font-mono tabular-nums text-foreground">{list.length}</span>
              </h2>
              <ul className="divide-y border-t">
                {list.map((t) => (
                  <Row key={t.id} t={t} now={now} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
