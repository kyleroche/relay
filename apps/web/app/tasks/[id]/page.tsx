import type { Metadata } from "next";
import { ArrowUpRight, Paperclip, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { board } from "@relay/core";
import { Alert } from "@/components/alert";
import { ActorChip } from "@/components/feed/actor-chip";
import { CloseAction } from "@/components/tasks/close-action";
import { ReleaseAction } from "@/components/tasks/release-action";
import { RequeueAction } from "@/components/tasks/requeue-action";
import { ReviewActions } from "@/components/tasks/review-actions";
import { TaskStateBadge } from "@/components/tasks/state-badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { SectionHeading } from "@/components/ui/section-heading";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { boardProblem, siteBoard, siteWorkers } from "@/lib/board";
import { BUILTIN_LANES, workerOfClaim } from "@/lib/board-read";
import { dataMode } from "@/lib/data";
import { fmtCost, fmtDuration, fmtInt, fmtTokens } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { claimProfile, decisionsFor, evalWait, taskPagePath } from "@/lib/tasks";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

type Loaded = { detail: board.TaskDetail; workers: board.WorkerView[] } | { problem: string } | null;

/** The task's thread from the board, once per request (the metadata and the page both ask); null when there is none. */
const load = cache(async (id: string): Promise<Loaded> => {
  try {
    const session = await siteBoard();
    const [detail, workers] = await Promise.all([board.getTask(session.board, id), siteWorkers().catch(() => [])]);
    return { detail, workers };
  } catch (e) {
    if (e instanceof board.TaskError && e.status === 404) return null;
    return { problem: boardProblem(e) };
  }
});

const taskId = async (params: Props["params"]): Promise<string> => decodeURIComponent((await params).id);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const l = await load(await taskId(params));
  return { title: l && "detail" in l ? l.detail.task.title || `Task ${l.detail.task.id}` : "Task", robots: { index: false } };
}

const fmtBytes = (n: number): string => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const mediaKind = (mime: string): string => (/^(image|video|audio)\//.exec(mime)?.[1] ?? (mime === "application/pdf" ? "pdf" : "file"));

/** What relay's own replies are called in the thread; a reply without the label is a person's (or another agent's) words. */
const RELAY_KIND: Record<string, string> = { log: "log", result: "result", brief: "brief", note: "note", asset: "output", usage: "usage" };

/**
 * One task, top to bottom: what it is (title, state, lane, model, project, repository), the gate's hold while it is
 * held, the decisions its state allows, the facts the board keeps (the pull request its hold names, the hold, what it
 * needs, who holds the claim and until when), its own text, the outputs attached to its thread, what its runs cost
 * and the thread in order. Everything is read from the team's Vercel Board as it stands; the actions are the same
 * core functions the API and the MCP tools call (lib/task-ops.ts).
 */
export default async function TaskPage({ params }: Props) {
  const id = await taskId(params);
  await requireSession(taskPagePath(id));
  const l = await load(id);
  if (!l) notFound();
  if ("problem" in l)
    return (
      <section className="py-6 sm:py-8">
        <Breadcrumb items={[{ label: "Board", href: "/" }, { label: id, mono: true }]} />
        <Alert tone="bad" className="mt-4">
          The board could not be read. {l.problem}
        </Alert>
      </section>
    );
  const { task: t, thread, usage } = l.detail;
  const now = Date.now();
  const canWrite = dataMode() === "db";
  const can = decisionsFor(t.state);
  const waits = evalWait(t);
  const worker = workerOfClaim(l.workers, t.claim);
  const servedLanes = board.servedLanes(l.workers);
  const replies = thread.replies.filter((m) => !m.deleted);
  const outputs = replies.flatMap((m) => board.blocksOf<board.AssetBlock>(m, board.ASSET_SCHEMA).map((a) => ({ ...a, name: m.attachments.find((f) => f.id === a.attachment)?.name ?? `${a.node}.${a.parameter}`, at: m.createdAt })));
  const words = replies.map((m) => ({ m, text: board.withoutBlocks(m.text), kind: m.labels?.[board.LABEL.relay] })).filter((r) => r.text);
  const total = usage.reduce((s, u) => ({ ctx: s.ctx + u.tokens_in + u.cache_read, out: s.out + u.tokens_out, cost: s.cost + u.cost_equiv }), { ctx: 0, out: 0, cost: 0 });
  const pr = t.pr?.number ?? null;
  const requeue = <RequeueAction taskId={t.id} lane={t.lane} model={t.model} state={t.state} builtinLanes={BUILTIN_LANES} servedLanes={servedLanes} canWrite={canWrite} />;
  const close = <CloseAction taskId={t.id} state={t.state} pr={pr} canWrite={canWrite} />;

  return (
    <>
      <section className="py-6 sm:py-8">
        <Breadcrumb items={[{ label: "Board", href: "/" }, { label: t.id, mono: true }]} />
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t.title || t.id}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {t.project ? (
                <Link href={`/projects/${t.project}`} className="text-xs hover:text-foreground">
                  {t.project}
                </Link>
              ) : (
                <span className="font-mono text-xs">{t.channel}</span>
              )}
              {t.lane ? <Pill mono>{t.lane}</Pill> : (can.requeue || t.state === "running") && <span className="text-xs">no lane</span>}
              {t.model && <span className="font-mono text-xs">{t.model}</span>}
              {t.repo && (
                <a href={`https://github.com/${t.repo}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-xs hover:text-primary">
                  {t.repo} <ArrowUpRight className="size-3" aria-hidden="true" />
                </a>
              )}
              {t.base && <span className="font-mono text-xs">from {t.base}</span>}
              {t.issue && (
                <a href={`https://github.com/${t.issue.repo}/issues/${t.issue.number}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-xs hover:text-primary">
                  issue #{t.issue.number} <ArrowUpRight className="size-3" aria-hidden="true" />
                </a>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            <TaskStateBadge state={t.state} />
            <p className="text-xs text-muted-foreground">
              opened <RelTime iso={t.created_at} now={now} /> by <ActorChip actor={board.feedActor(thread.message.by, thread.message.author?.handle)} className="align-middle" />
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-6">
        {t.state === "held" && (
          <section aria-labelledby="held-h" className="rounded-lg border border-warn/40 bg-warn/5 p-4">
            <SectionHeading id="held-h">
              <span className="inline-flex items-center gap-1.5">
                <ShieldAlert className="size-4 text-warn" aria-hidden="true" /> Held at the gate
              </span>
            </SectionHeading>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The injection gate read the task&apos;s text and found instructions aimed at the agent rather than at the work. No worker runs it until someone reads the text below and releases it; a release covers the text as it stands, and anything added later is graded again. A tripwire, not a boundary: the sandbox and the allowlist still apply after a release.
            </p>
            {t.hold?.reason && <p className="mt-3 whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-xs">{t.hold.reason}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ReleaseAction taskId={t.id} canWrite={canWrite} />
              {requeue}
              {close}
            </div>
          </section>
        )}

        {t.state !== "held" && (can.review || can.requeue || can.close) && (
          <section aria-labelledby="decide-h" className="rounded-lg border bg-card p-4">
            <SectionHeading id="decide-h">Decide</SectionHeading>
            <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
              {t.state === "review"
                ? t.pr
                  ? `Approve squash-merges PR #${t.pr.number} and completes the task; Request changes sends your note to the next run.`
                  : "The deliverable is the outputs below: Approve accepts them and completes the task; Request changes sends your note to the next run."
                : waits
                  ? `The ${waits.step} step on the ${waits.lane} lane is looking at the work; it comes to review when that ends. Requeue lifts the hold and starts over; Close finishes it without a merge.`
                  : t.state === "blocked"
                    ? "The board holds this task. Requeue lifts the hold and puts it back in the queue; Close finishes it without a merge."
                    : t.state === "failed"
                      ? "The run failed. Requeue starts it over, on this lane or another; Close finishes it without a merge."
                      : t.state === "running"
                        ? "A worker holds this task until its lease ends, so it cannot be requeued. Close stops the run at its next look."
                        : "Requeue moves it to another lane or model; Close finishes it without a merge."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {can.review && <ReviewActions taskId={t.id} pr={pr} canWrite={canWrite} />}
              {can.requeue && requeue}
              {can.close && close}
            </div>
          </section>
        )}

        <section aria-label="Where it stands" className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <SectionHeading>Pull request</SectionHeading>
            {t.pr ? (
              <a href={t.pr.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-sm hover:text-primary">
                {t.pr.repo}#{t.pr.number} <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </a>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t.state === "done" || t.state === "closed" ? "None waiting: the task is finished." : outputs.length ? "None: the deliverable is the outputs below." : "None yet. A task in review names the pull request it waits on."}</p>
            )}
            {t.result && <p className="mt-1 text-xs text-ok">{t.result}</p>}
            {t.reason && <p className={t.state === "failed" ? "mt-1 text-xs text-bad" : "mt-1 text-xs text-muted-foreground"}>{t.reason}</p>}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <SectionHeading>On the board</SectionHeading>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-xs text-muted-foreground">Hold</dt>
              <dd className="min-w-0 text-xs">
                {t.hold ? (
                  <>
                    <span className="font-mono">{t.hold.kind || "held"}</span>
                    {t.hold.reason && <span className="ml-2 break-words text-muted-foreground">{t.hold.reason}</span>}
                  </>
                ) : (
                  <span className="text-muted-foreground">none</span>
                )}
              </dd>
              <dt className="text-xs text-muted-foreground">Needs</dt>
              <dd className="text-xs">
                {t.needs.length ? (
                  t.needs.map((n, i) => (
                    <span key={n}>
                      {i > 0 && ", "}
                      <Link href={taskPagePath(n)} className="font-mono hover:text-primary">
                        {n}
                      </Link>
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">nothing</span>
                )}
              </dd>
              <dt className="text-xs text-muted-foreground">Claim</dt>
              <dd className="text-xs">
                {t.claim ? (
                  <>
                    <Link href="/workers" className="hover:text-primary" title={t.claim.actor}>
                      {worker?.name ?? claimProfile(t.claim.actor)}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      until <RelTime iso={t.claim.until} now={now} />
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">nobody</span>
                )}
              </dd>
              {t.evaluates && (
                <>
                  <dt className="text-xs text-muted-foreground">Looks at</dt>
                  <dd className="text-xs">
                    <Link href={taskPagePath(t.evaluates)} className="font-mono hover:text-primary">
                      {t.evaluates}
                    </Link>
                    {t.step && <span className="ml-2 text-muted-foreground">as the {t.step} step</span>}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </section>

        {t.body && (
          <section aria-labelledby="text-h" className="rounded-lg border bg-card p-4">
            <SectionHeading id="text-h">The task</SectionHeading>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{t.body}</p>
          </section>
        )}

        {outputs.length > 0 && (
          <section aria-labelledby="outputs-h" className="rounded-lg border bg-card p-4">
            <SectionHeading id="outputs-h" count={outputs.length}>
              Outputs
            </SectionHeading>
            <ul className="mt-2 divide-y">
              {outputs.map((o) => (
                <li key={`${o.attachment}:${o.index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <Paperclip className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 break-all font-mono text-xs">{o.name}</span>
                  <Pill size="sm">{mediaKind(o.mime)}</Pill>
                  <span className="font-mono text-xs text-muted-foreground">{fmtBytes(o.bytes)}</span>
                  <span className="font-mono text-xs text-muted-foreground">v{o.version}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    <RelTime iso={o.at} now={now} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="usage-h" className="rounded-lg border bg-card p-4">
          <SectionHeading id="usage-h" count={usage.length || null} action={usage.length ? `${fmtCost(total.cost)} equivalent · ${fmtTokens(total.ctx)} in / ${fmtTokens(total.out)} out` : undefined}>
            Usage
          </SectionHeading>
          {usage.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No model call recorded yet.</p>
          ) : (
            <Table className="mt-2 text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Call</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Context</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Took</TableHead>
                  <TableHead>Worker</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.map((u, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      {u.kind === "step" ? `step ${u.step ?? ""}` : u.kind}
                      {u.kind === "run" && <span className="ml-1 font-mono text-muted-foreground">{u.lane}</span>}
                      {u.outcome && <span className="ml-1 text-muted-foreground">({u.outcome})</span>}
                    </TableCell>
                    <TableCell className="font-mono">{u.model ?? "default"}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtInt(u.tokens_in + u.cache_read)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtInt(u.tokens_out)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtCost(u.cost_equiv)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtDuration(u.duration_ms)}</TableCell>
                    <TableCell>{u.worker}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section aria-labelledby="thread-h">
          <SectionHeading id="thread-h" count={words.length} className="mb-2">
            Thread
          </SectionHeading>
          {words.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Nothing yet. A run&apos;s lines, the lane&apos;s summary and the notes people leave appear here in order.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {words.map(({ m, text, kind }) => (
                <li key={m.id} className="rounded-md border bg-card p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <ActorChip actor={board.feedActor(m.by, m.author?.handle)} />
                    {kind && (
                      <Pill mono size="sm">
                        {RELAY_KIND[kind] ?? kind}
                      </Pill>
                    )}
                    <RelTime iso={m.createdAt} now={now} />
                    {m.attachments.map((f) => (
                      <span key={f.id} className="inline-flex items-center gap-1 font-mono">
                        <Paperclip className="size-3" aria-hidden="true" />
                        {f.name}
                      </span>
                    ))}
                  </p>
                  <p className={kind === "log" ? "mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground" : "mt-1 whitespace-pre-wrap break-words leading-6"}>{text}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
