import type { Metadata } from "next";
import { ArrowUpRight, Globe, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CLOUD_LANES, parseTaskId, repo as core, WORKER_LANES, type TaskView } from "@relay/core";
type EventRow = core.EventRow;
import { EventRow as FeedRow } from "@/components/feed/event-row";
import { RequeueAction } from "@/components/tasks/requeue-action";
import { ReviewActions } from "@/components/tasks/review-actions";
import { PreviewBadge, TaskStateBadge } from "@/components/tasks/state-badge";
import { Pill } from "@/components/ui/pill";
import { SectionHeading } from "@/components/ui/section-heading";
import { dataMode } from "@/lib/data";
import { toFeedEvent } from "@/lib/data-db";
import { getDb } from "@/lib/db";
import { fmtAgo, fmtCost, fmtDuration, fmtTokens } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { taskTitle } from "@/lib/tasks";
import { viewerTimeZone } from "@/lib/tz-server";

type Props = { params: Promise<{ owner: string; repo: string; n: string }> };

export const dynamic = "force-dynamic";

interface Loaded {
  task: TaskView;
  events: EventRow[];
  title: string;
}

async function load(p: { owner: string; repo: string; n: string }): Promise<Loaded | null> {
  if (dataMode() !== "db") return null;
  const id = `${p.owner}/${p.repo}#${p.n}`;
  if (!parseTaskId(id)) return null;
  const db = await getDb();
  const row = await core.getTask(db, id);
  if (!row) return null;
  const [task, events] = await Promise.all([core.taskView(db, row), core.taskEvents(db, row)]);
  return { task, events, title: taskTitle(task, events) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const l = await load(p);
  return { title: l ? `${l.task.id}: ${l.title}` : "Task not found", robots: { index: false } };
}

const REVIEW_KINDS = new Set(["task.approved", "task.changes_requested", "task.merge_failed", "task.requeued", "pr.review", "pr.merged", "pr.opened", "pr.closed"]);
/** States a task can be requeued from on this page: anything in flight or stuck. A queued task is already queued; a done one is finished. */
const REQUEUE_STATES = new Set(["running", "failed", "review", "claimed"]);

/**
 * One task, top to bottom: the issue (title, id, lane, state, worker), the preview as the primary element when there
 * is one, the decision buttons while the task is in review (and Requeue whenever the task is in flight or stuck), the
 * PR, the run's summary and cost, the review history and
 * every feed row about the task. Everything of record is on GitHub; this page reads the feed and acts through the
 * same core functions the API and the MCP tools use.
 */
export default async function TaskPage({ params }: Props) {
  const p = await params;
  await requireSession(`/tasks/${p.owner}/${p.repo}/${p.n}`);
  const [l, tz] = await Promise.all([load(p), viewerTimeZone()]);
  if (!l) notFound();
  const { task: t, events, title } = l;
  const now = Date.now();
  const history = events.filter((e) => REVIEW_KINDS.has(e.kind)).slice(-12).reverse();
  const inReview = t.state === "review";
  const canRequeue = REQUEUE_STATES.has(t.state);
  const mergeFailed = inReview ? [...events].reverse().find((e) => e.kind === "task.merge_failed") : undefined;
  const lastDecisionAt = t.review.at ?? "";
  const showMergeFailure = mergeFailed && mergeFailed.ts >= lastDecisionAt;

  return (
    <>
      <section className="py-6 sm:py-8">
        <p className="text-xs text-muted-foreground">
          <Link href="/tasks" className="hover:text-foreground">
            Tasks
          </Link>{" "}
          / <span className="font-mono">{t.id}</span>
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <a href={t.issue_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-xs hover:text-primary">
                {t.repo}#{t.issue} <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
              {t.lane ? <Pill mono>{t.lane}</Pill> : <span className="text-xs">no lane</span>}
              {t.runner && <span className="font-mono text-xs">{t.runner.replace(/^runner:/, "worker ")}</span>}
              {t.branch && <span className="font-mono text-xs">{t.branch}</span>}
              <Link href={`/projects/${t.project}`} className="text-xs hover:text-foreground">
                {t.project}
              </Link>
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            <TaskStateBadge state={t.state} />
            {t.updated_at && <p className="text-xs text-muted-foreground">{fmtAgo(t.updated_at, now)}</p>}
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-6">
        {t.preview_url ? (
          <section aria-labelledby="preview-h" className="rounded-lg border bg-card p-4">
            <SectionHeading id="preview-h">
              Preview <PreviewBadge state={t.preview_state} />
            </SectionHeading>
            <a
              href={t.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-2 text-lg font-medium text-primary underline-offset-4 hover:underline"
            >
              <Globe className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t.preview_url.replace(/^https?:\/\//, "")}</span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
            </a>
            <p className="mt-1 text-xs text-muted-foreground">Built from {t.branch ?? "the task's branch"} by Vercel or the repository's deployment.</p>
          </section>
        ) : (
          inReview && (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              {t.preview_state === "failed" ? "The preview build failed; the feed row below links to the build log." : "No preview yet. It appears here when Vercel (or a GitHub deployment) reports the branch built."}
            </p>
          )
        )}

        {(inReview || canRequeue) && (
          <section aria-labelledby="decide-h" className="rounded-lg border bg-card p-4">
            <SectionHeading id="decide-h">Decide</SectionHeading>
            <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
              {inReview
                ? `Approve squash-merges ${t.pr ? `PR #${t.pr}` : "the pull request"}; Request changes sends your note to the next run.`
                : t.lane?.endsWith("-cloud")
                  ? "A cloud lane holds this task; if that lane is not wired, requeue it on a worker lane."
                  : t.state === "failed"
                    ? "The run failed; Requeue starts it over, on this lane or another."
                    : "A worker has this task; Requeue releases it and starts over, on this lane or another."}
            </p>
            {showMergeFailure && (
              <p role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  GitHub refused the last merge: {typeof mergeFailed.payload.error === "string" ? mergeFailed.payload.error : mergeFailed.summary}. Resolve it on the PR (conflicts, required checks) and approve again.
                </span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {inReview && <ReviewActions taskId={t.id} pr={t.pr} canWrite={dataMode() === "db"} />}
              <RequeueAction taskId={t.id} lane={t.lane} state={t.state} workerLanes={WORKER_LANES} cloudLanes={CLOUD_LANES} canWrite={dataMode() === "db"} />
            </div>
          </section>
        )}

        <section aria-labelledby="result-h" className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <SectionHeading id="result-h">Pull request</SectionHeading>
            {t.pr ? (
              <a href={t.pr_url ?? "#"} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-sm hover:text-primary">
                #{t.pr} <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </a>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t.state === "queued" || t.state === "claimed" || t.state === "running" ? "Opens when the run finishes." : "None."}</p>
            )}
            {t.merged_at && <p className="mt-1 text-xs text-ok">merged {fmtAgo(t.merged_at, now)}</p>}
            {t.review.decided && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t.review.decided === "approved" ? "approved" : "changes requested"} by <span className="font-mono">{t.review.by}</span>
                {t.review.at ? ` ${fmtAgo(t.review.at, now)}` : ""}
              </p>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <SectionHeading>Cost</SectionHeading>
            {t.usage ? (
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-xs text-muted-foreground">Equivalent</dt>
                <dd className="font-mono tabular-nums">{fmtCost(t.usage.cost_equiv)}</dd>
                <dt className="text-xs text-muted-foreground">Context / out</dt>
                <dd className="font-mono tabular-nums">
                  {fmtTokens(t.usage.tokens_in + t.usage.cache_read)} / {fmtTokens(t.usage.tokens_out)}
                </dd>
                <dt className="text-xs text-muted-foreground">Runs</dt>
                <dd className="font-mono tabular-nums">
                  {t.usage.runs}
                  {t.usage.duration_ms ? <span className="ml-1 text-xs text-muted-foreground">last {fmtDuration(t.usage.duration_ms)}</span> : null}
                </dd>
                {t.usage.model && (
                  <>
                    <dt className="text-xs text-muted-foreground">Model</dt>
                    <dd className="truncate font-mono text-xs">{t.usage.model}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">No model call recorded yet.</p>
            )}
          </div>
        </section>

        {t.run_summary && (
          <section aria-labelledby="summary-h" className="rounded-lg border bg-card p-4">
            <SectionHeading id="summary-h">What the {t.lane ?? ""} lane said</SectionHeading>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{t.run_summary}</p>
            <p className="mt-2 text-xs text-muted-foreground">The full summary and the usage block are the PR's first comment.</p>
          </section>
        )}

        {history.length > 0 && (
          <section aria-labelledby="history-h">
            <SectionHeading id="history-h" className="mb-2">
              Review history
            </SectionHeading>
            <ul className="flex flex-col gap-2">
              {history.map((e) => (
                <li key={e.id} className="rounded-md border bg-card p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="font-mono">{e.kind}</span>
                    <span className="font-mono">{e.actor}</span>
                    <time dateTime={e.ts}>{fmtAgo(e.ts, now)}</time>
                    {e.url && (
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-primary">
                        open <ArrowUpRight className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </p>
                  <p className="mt-1">{e.kind === "task.merge_failed" ? <span className="text-muted-foreground">merge refused</span> : e.summary}</p>
                  {e.kind === "task.changes_requested" && typeof e.payload.note === "string" && <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{e.payload.note}</p>}
                  {e.kind === "task.requeued" && typeof e.payload.reason === "string" && e.payload.reason && <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{e.payload.reason}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="events-h">
          <SectionHeading id="events-h" count={events.length} className="mb-2">
            Every event
          </SectionHeading>
          <ol className="flex flex-col divide-y rounded-md border bg-card">
            {[...events].reverse().map((e) => (
              <FeedRow key={e.id} event={toFeedEvent(e)} tz={tz} showProject={false} />
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
