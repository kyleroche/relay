import type { Metadata } from "next";
import { ArrowUpRight, Globe } from "lucide-react";
import Link from "next/link";
import { repo, TASK_STATES, type TaskState, type TaskView } from "@relay/core";
import { CopyButton } from "@/components/copy-button";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { fmtAgo, fmtCost } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { REVIEW_AGENT_PROMPT, STATE_HINT, STATE_TONE, taskPagePath } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Tasks",
  description: "Every task relay knows, with its derived state: what is queued, what a worker is on, what waits for a decision, what shipped.",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

function Row({ t, now }: { t: TaskView; now: number }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border bg-card p-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <Link href={taskPagePath(t)} className="font-medium hover:text-primary">
          <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
          <span className="ml-2">{t.run_summary ?? t.summary ?? "—"}</span>
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{t.lane ?? "no lane"}</span>
          {t.runner && <span className="font-mono">{t.runner.replace(/^runner:/, "")}</span>}
          {t.pr && (
            <a href={t.pr_url ?? "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-primary">
              PR #{t.pr} <ArrowUpRight className="size-3" aria-hidden="true" />
            </a>
          )}
          {t.preview_url && (
            <a href={t.preview_url} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 hover:text-primary", t.preview_state === "ready" ? "text-ok" : "")}>
              <Globe className="size-3" aria-hidden="true" /> preview{t.preview_state !== "ready" ? ` (${t.preview_state})` : ""}
            </a>
          )}
          {t.usage && <span className="font-mono tabular-nums">{fmtCost(t.usage.cost_equiv)}</span>}
          {t.updated_at && <span>{fmtAgo(t.updated_at, now)}</span>}
        </p>
      </div>
      <span className={cn("shrink-0 font-mono text-xs", STATE_TONE[t.state])} title={STATE_HINT[t.state]}>
        {t.state}
      </span>
    </li>
  );
}

/**
 * /tasks: every task with its derived state, the ones waiting for a decision first. A task is a GitHub issue; this
 * page is the read model over the feed (DESIGN.md), and the task page is where a decision is made.
 */
export default async function TasksPage() {
  await requireSession("/tasks");
  const db = dataMode() === "db";
  const tasks = db ? await repo.listTaskViews(await getDb(), { limit: 200 }) : [];
  const now = Date.now();
  const byState = new Map<TaskState, TaskView[]>();
  for (const t of tasks) byState.set(t.state, [...(byState.get(t.state) ?? []), t]);
  const order: TaskState[] = ["review", "running", "claimed", "queued", "failed", "done"];
  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every task is a GitHub issue with a lane label; its state is folded from the feed each time you look. The ones in <span className="text-warn">review</span> have a pull request and,
          when Vercel has built it, a preview: open the task to see it and decide.
        </p>
        {!db && <p className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">This deployment runs on demo data; tasks need a database (RELAY_DATA=db or DATABASE_URL).</p>}
      </section>

      <section aria-labelledby="review-agent-h" className="relative mb-8 rounded-lg border bg-card p-4">
        <CopyButton text={REVIEW_AGENT_PROMPT} className="absolute right-2 top-2" />
        <div className="pr-10">
          <h2 id="review-agent-h" className="text-sm font-medium">
            Review from chat
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Hand this to the bot that should tell you when a preview is up and approve when you say so. The buttons on each task page do the same thing by hand.</p>
        </div>
        <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-foreground">{REVIEW_AGENT_PROMPT}</p>
      </section>

      {db && tasks.length === 0 && (
        <p className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
          No tasks yet. Open one with <code className="rounded bg-muted px-1 font-mono text-xs">relay task create --title … --lane claude</code>, the <code className="rounded bg-muted px-1 font-mono text-xs">relay_task_create</code> tool, or an <code className="rounded bg-muted px-1 font-mono text-xs">agent:*</code> label on a GitHub issue.
        </p>
      )}
      <div className="flex flex-col gap-8">
        {order.map((state) => {
          const list = byState.get(state);
          if (!list?.length) return null;
          return (
            <section key={state} aria-labelledby={`state-${state}`}>
              <h2 id={`state-${state}`} className="mb-2 flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
                <span className={cn("font-mono", STATE_TONE[state])}>{state}</span>
                <span className="font-mono tabular-nums text-foreground">{list.length}</span>
                <span className="font-normal">{STATE_HINT[state]}</span>
              </h2>
              <ul className="flex flex-col gap-2">
                {list.map((t) => (
                  <Row key={t.id} t={t} now={now} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <section className="mt-10 max-w-2xl">
        <h2 className="text-lg font-semibold tracking-tight">How state is derived</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
          {TASK_STATES.map((k) => (
            <li key={k} className="flex gap-2">
              <span className={cn("w-16 shrink-0 font-mono text-xs", STATE_TONE[k])}>{k}</span>
              <span>{STATE_HINT[k]}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
