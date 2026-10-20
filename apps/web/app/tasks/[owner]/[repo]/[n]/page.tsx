import type { Metadata } from "next";
import { ArrowUpRight, Globe, ShieldAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CLOUD_LANES, heldInfo, parseTaskId, repo as core, WORKER_LANES, type TaskView } from "@relay/core";
type EventRow = core.EventRow;
import { Thumb } from "@/components/assets/asset-card";
import { AssetReviewActions } from "@/components/assets/asset-review-actions";
import { AssetViewer } from "@/components/assets/asset-viewer";
import { AssetStatusBadge } from "@/components/assets/status-badge";
import { ActorChip } from "@/components/feed/actor-chip";
import { EventRow as FeedRow } from "@/components/feed/event-row";
import { ReleaseAction } from "@/components/tasks/release-action";
import { RequeueAction } from "@/components/tasks/requeue-action";
import { ReviewActions } from "@/components/tasks/review-actions";
import { PreviewBadge, TaskStateBadge } from "@/components/tasks/state-badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Pill } from "@/components/ui/pill";
import { SectionHeading } from "@/components/ui/section-heading";
import { dataMode, getAsset, getFeed, getTasks } from "@/lib/data";
import { toFeedEvent } from "@/lib/data-db";
import { getDb } from "@/lib/db";
import { fmtAgo, fmtCost, fmtDuration, fmtTokens } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { taskTitle } from "@/lib/tasks";
import { viewerTimeZone } from "@/lib/tz-server";
import type { AssetDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = { params: Promise<{ owner: string; repo: string; n: string }> };

export const dynamic = "force-dynamic";

interface Loaded {
  task: TaskView;
  events: EventRow[];
  title: string;
}

async function load(p: { owner: string; repo: string; n: string }): Promise<Loaded | null> {
  const id = `${p.owner}/${p.repo}#${p.n}`;
  if (!parseTaskId(id)) return null;
  if (dataMode() !== "db") {
    // demo data: the task the board folded from the dataset's events, and those events (lib/data-mock.ts)
    const task = (await getTasks({ limit: 500 })).find((t) => t.id === id);
    if (!task) return null;
    const events = (await getFeed({ project: task.project, limit: 500 })).filter((e) => e.repo === task.repo && e.issue === task.issue) as unknown as EventRow[];
    return { task, events, title: taskTitle(task, events) };
  }
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

const REVIEW_KINDS = new Set(["task.approved", "task.changes_requested", "task.merge_failed", "task.requeued", "task.held", "task.released", "pr.review", "pr.merged", "pr.opened", "pr.closed", "asset.uploaded", "asset.reviewed"]);
/** States a task can be requeued from on this page: anything but done. A queued task is requeued to move it to another lane. */
const REQUEUE_STATES = new Set(["queued", "running", "failed", "review", "claimed"]);

/**
 * One task, top to bottom: the issue (title, id, lane, state, worker), the Held card while the injection gate holds
 * it (score, reasons, Release and Requeue), the preview as the primary element when there
 * is one, the decision buttons while the task is in review (and Requeue whenever the task is in flight or stuck), the
 * asset the task delivered when its deliverable is one (the viewer, the versions, Approve / Reject; the asset path in
 * docs/ARCHITECTURE.md "A task's life"), the PR, the run's summary and cost, the review history and
 * every feed row about the task. Everything of record is on GitHub; this page reads the feed and acts through the
 * same core functions the API and the MCP tools use.
 */
export default async function TaskPage({ params }: Props) {
  const p = await params;
  await requireSession(`/tasks/${p.owner}/${p.repo}/${p.n}`);
  const [l, tz] = await Promise.all([load(p), viewerTimeZone()]);
  if (!l) notFound();
  const { task: t, events, title } = l;
  const asset: AssetDetail | null = t.asset ? await getAsset(t.asset.id) : null;
  const now = Date.now();
  const history = events.filter((e) => REVIEW_KINDS.has(e.kind)).slice(-12).reverse();
  const inReview = t.state === "review";
  const canRequeue = REQUEUE_STATES.has(t.state);
  const isHeld = t.state === "held";
  const held = isHeld ? heldInfo(events) : undefined;
  const mergeFailed = inReview ? [...events].reverse().find((e) => e.kind === "task.merge_failed") : undefined;
  const lastDecisionAt = t.review.at ?? "";
  const showMergeFailure = mergeFailed && mergeFailed.ts >= lastDecisionAt;

  return (
    <>
      <section className="py-6 sm:py-8">
        <Breadcrumb items={[{ label: "Board", href: "/" }, { label: t.id, mono: true }]} />
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <a href={t.issue_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-xs hover:text-primary">
                {t.repo}#{t.issue} <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
              {t.lane ? <Pill mono>{t.lane}</Pill> : <span className="text-xs">no lane</span>}
              {t.runner && <ActorChip actor={t.runner} />}
              {t.branch && <span className="font-mono text-xs">{t.branch}</span>}
              <Link href={`/projects/${t.project}`} className="text-xs hover:text-foreground">
                {t.project}
              </Link>
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            <TaskStateBadge state={t.state} />
            {t.updated_at && (
              <time dateTime={t.updated_at} title={t.updated_at} className="text-xs text-muted-foreground">
                {fmtAgo(t.updated_at, now)}
              </time>
            )}
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-6">
        {isHeld && (
          <section aria-labelledby="held-h" className="rounded-lg border border-warn/40 bg-warn/5 p-4">
            <SectionHeading id="held-h">
              <span className="inline-flex items-center gap-1.5">
                <ShieldAlert className="size-4 text-warn" aria-hidden="true" /> Held at the gate
              </span>
            </SectionHeading>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The injection gate read the issue text{held?.grader === "precheck" ? " (a marker no honest feature request contains)" : held?.grader === "model" ? ` (${held.model ?? "the grader"})` : ""} and found instructions aimed at the agent rather than at the work. No worker runs it until someone reads the issue and releases it; the next worker grades it again. A tripwire, not a boundary: the sandbox and the allowlist still apply after a release.
            </p>
            {held && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-xs text-muted-foreground">Score</dt>
                <dd className="font-mono tabular-nums">{held.score.toFixed(2)}</dd>
                <dt className="text-xs text-muted-foreground">Held by</dt>
                <dd className="text-xs">
                  <ActorChip actor={held.by} className="align-middle" />{" "}
                  <time dateTime={held.at} title={held.at}>
                    {fmtAgo(held.at, now)}
                  </time>
                </dd>
                <dt className="text-xs text-muted-foreground">Reasons</dt>
                <dd>
                  <ul className="flex flex-col gap-0.5">
                    {held.reasons.map((r, i) => (
                      <li key={i} className="whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-xs">
                        {r}
                      </li>
                    ))}
                  </ul>
                </dd>
              </dl>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ReleaseAction taskId={t.id} canWrite={dataMode() === "db"} />
              <RequeueAction taskId={t.id} lane={t.lane} state={t.state} workerLanes={WORKER_LANES} cloudLanes={CLOUD_LANES} canWrite={dataMode() === "db"} />
            </div>
          </section>
        )}

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
          inReview &&
          !t.asset && (
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
                ? t.asset
                  ? "The deliverable is the asset in the card below: Approve accepts it and closes the issue; Reject sends your note to the next run. Requeue starts over on a lane."
                  : `Approve squash-merges ${t.pr ? `PR #${t.pr}` : "the pull request"}; Request changes sends your note to the next run.`
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
              {inReview && !t.asset && <ReviewActions taskId={t.id} pr={t.pr} canWrite={dataMode() === "db"} />}
              <RequeueAction taskId={t.id} lane={t.lane} state={t.state} workerLanes={WORKER_LANES} cloudLanes={CLOUD_LANES} canWrite={dataMode() === "db"} />
            </div>
          </section>
        )}

        {asset && (
          <section aria-labelledby="asset-h" className="rounded-lg border bg-card p-4">
            <SectionHeading
              id="asset-h"
              action={
                <Link href={`/assets/${asset.asset.id}`} className="inline-flex items-center gap-0.5 text-primary underline underline-offset-4">
                  Open in the library <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              }
            >
              Asset <AssetStatusBadge status={asset.asset.status} />
            </SectionHeading>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="text-foreground">{asset.asset.title}</span>
              <span className="font-mono">v{asset.asset.version}</span>
              <span>{asset.asset.kind}</span>
              <span className="font-mono">{asset.asset.mime}</span>
              <span>
                by <ActorChip actor={asset.asset.created_by} className="align-middle" />
              </span>
            </p>
            <div className="mt-3">
              <AssetViewer asset={asset.asset} />
            </div>
            {asset.versions.length > 1 && (
              <ol className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Versions">
                {asset.versions.map((v) => {
                  const current = v.id === asset.asset.id;
                  return (
                    <li key={v.id} className="shrink-0">
                      <Link href={`/assets/${v.id}`} aria-current={current ? "page" : undefined} className={cn("flex w-28 flex-col gap-1 rounded-md border p-1.5 transition-colors hover:border-primary/50", current && "border-primary ring-1 ring-primary")}>
                        <Thumb asset={{ thumb_url: v.thumb_url, kind: asset.asset.kind, title: asset.asset.title, url: null }} className="aspect-[16/10] rounded-sm" />
                        <span className="flex items-center justify-between font-mono text-[11px]">
                          <span>v{v.version}</span>
                          <span className="text-muted-foreground">{fmtAgo(v.created_at, now)}</span>
                        </span>
                        <AssetStatusBadge status={v.status} className="w-fit" />
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
            {asset.asset.review_note && (
              <p className="mt-3 rounded bg-muted p-2 text-xs">
                <span className="text-muted-foreground">{asset.asset.status === "rejected" ? "Rejected" : "Reviewed"} by </span>
                {asset.asset.reviewed_by && <ActorChip actor={asset.asset.reviewed_by} className="align-middle" />}
                <span className="mt-1 block whitespace-pre-wrap font-mono">{asset.asset.review_note}</span>
              </p>
            )}
            {asset.asset.status === "pending" && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <AssetReviewActions assetId={asset.asset.id} version={asset.asset.version} canWrite={dataMode() === "db"} />
              </div>
            )}
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
              <p className="mt-1 text-sm text-muted-foreground">{t.asset ? "None: the deliverable is the asset above." : t.state === "queued" || t.state === "claimed" || t.state === "running" ? "Opens when the run finishes." : "None."}</p>
            )}
            {t.merged_at && (
              <p className="mt-1 text-xs text-ok">
                merged{" "}
                <time dateTime={t.merged_at} title={t.merged_at}>
                  {fmtAgo(t.merged_at, now)}
                </time>
              </p>
            )}
            {t.review.decided && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t.review.decided === "approved" ? "approved" : "changes requested"} by {t.review.by && <ActorChip actor={t.review.by} className="align-middle" />}
                {t.review.at && (
                  <>
                    {" "}
                    <time dateTime={t.review.at} title={t.review.at}>
                      {fmtAgo(t.review.at, now)}
                    </time>
                  </>
                )}
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
                    <ActorChip actor={e.actor} />
                    <time dateTime={e.ts} title={e.ts}>
                      {fmtAgo(e.ts, now)}
                    </time>
                    {e.url && (
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-primary">
                        open <ArrowUpRight className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </p>
                  <p className="mt-1">{e.kind === "task.merge_failed" ? <span className="text-muted-foreground">merge refused</span> : e.summary}</p>
                  {(e.kind === "task.changes_requested" || e.kind === "asset.reviewed") && typeof e.payload.note === "string" && e.payload.note && <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{e.payload.note}</p>}
                  {e.kind === "task.requeued" && typeof e.payload.reason === "string" && e.payload.reason && <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{e.payload.reason}</p>}
                  {e.kind === "task.held" && Array.isArray(e.payload.reasons) && e.payload.reasons.length > 0 && <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{(e.payload.reasons as unknown[]).map(String).join("\n")}</p>}
                  {e.kind === "task.released" && typeof e.payload.note === "string" && e.payload.note && <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{e.payload.note}</p>}
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
