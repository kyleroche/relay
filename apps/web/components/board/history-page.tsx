import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { TASK_STATES, type TaskState } from "@relay/core";
import { HomeTabs } from "@/components/home-tabs";
import { ProjectFilter } from "@/components/board/project-filter";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { getHistory, getProjects } from "@/lib/data";
import { fmtCost } from "@/lib/format";
import { STATE_HINT, STATE_TONE, taskPagePath } from "@/lib/tasks";
import type { BoardTask } from "@/lib/types";

/**
 * The archive behind the board (DESIGN.md, "Board"): every task newest first, one row each, over the same state cache
 * the board reads. The board's Done column shows the newest ten and links here; Failed links here for what fell off
 * its week. Filters are pills in the URL (state, project), paging is "Older" by keyset so a page never repeats a row
 * while tasks move. A row links to the task's page; there is nothing to decide here, the board is for that.
 */

export const HISTORY_METADATA: Metadata = {
  title: "History",
  description: "Every task relay has run, newest first: merged, closed, failed and the ones still moving, with the lane, the worker, the PR and the cost.",
  alternates: { canonical: "/history" },
  robots: { index: false },
};

export type HistorySearch = { state?: string; project?: string; before?: string };

const PAGE = 50;

const isState = (s: string | undefined): s is TaskState => !!s && (TASK_STATES as readonly string[]).includes(s);

/** `before=<since>~<id>`: the previous page's last row. */
function parseBefore(s: string | undefined): { since: string; id: string } | null {
  if (!s) return null;
  const i = s.lastIndexOf("~");
  if (i <= 0) return null;
  const since = s.slice(0, i);
  const id = s.slice(i + 1);
  return Number.isNaN(Date.parse(since)) || !id ? null : { since, id };
}

function historyHref(q: { state?: string; project?: string; before?: string }): string {
  const qs = new URLSearchParams();
  if (q.state) qs.set("state", q.state);
  if (q.project) qs.set("project", q.project);
  if (q.before) qs.set("before", q.before);
  const s = qs.toString();
  return s ? `/history?${s}` : "/history";
}

function Row({ t, now }: { t: BoardTask; now: number }) {
  const title = t.title ?? `#${t.issue}`;
  const runner = t.runner ? t.runner.replace(/^runner:/, "") : null;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
      <div className="hidden sm:block">
        <Pill tone={STATE_TONE[t.state]} title={STATE_HINT[t.state]}>
          {t.state}
        </Pill>
      </div>
      <div className="min-w-0">
        <Link href={taskPagePath(t)} className="line-clamp-1 font-medium hover:text-primary">
          {title}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Pill tone={STATE_TONE[t.state]} size="sm" className="sm:hidden">
            {t.state}
          </Pill>
          <span className="font-mono">{t.id}</span>
          {t.lane && (
            <Pill mono size="sm">
              {t.lane}
            </Pill>
          )}
          {runner && <span>{runner}</span>}
          {t.pr && (
            <a href={t.pr_url ?? "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-primary">
              PR #{t.pr} <ArrowUpRight className="size-3" aria-hidden="true" />
            </a>
          )}
          {t.state === "failed" && t.last_error && <span className="line-clamp-1 text-bad">{t.last_error}</span>}
        </p>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <RelTime iso={t.since} now={now} />
        {t.cost != null && t.cost > 0 && <p className="font-mono tabular-nums">{fmtCost(t.cost)}</p>}
      </div>
    </li>
  );
}

export async function HistoryPage({ searchParams }: { searchParams: Promise<HistorySearch> }) {
  const q = await searchParams;
  const state = isState(q.state) ? q.state : undefined;
  const project = q.project || undefined;
  const before = parseBefore(q.before);
  const [rows, projects] = await Promise.all([getHistory({ limit: PAGE + 1, ...(state ? { state } : {}), ...(project ? { project } : {}), before }), getProjects()]);
  const now = Date.now();
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  const older = rows.length > PAGE && last ? historyHref({ state, project, before: `${last.since}~${last.id}` }) : null;
  const states: Array<{ key: string; label: string }> = [{ key: "", label: "All" }, ...TASK_STATES.map((s) => ({ key: s, label: s }))];

  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="sr-only">History</h1>
        <HomeTabs active="history" />
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Every task, newest first: what merged, what was closed, what failed, and what is still moving. The board shows the newest ten done; this is the rest.</p>
        <nav aria-label="State filter" className="mt-2">
          <ul className="flex flex-wrap items-center gap-1">
            {states.map((s) => (
              <Pill key={s.key || "all"} asChild mono={!!s.key} tone={(state ?? "") === s.key ? "primary" : "muted"} className="hover:text-foreground">
                <li>
                  <Link href={historyHref({ state: s.key || undefined, project })} aria-current={(state ?? "") === s.key ? "true" : undefined}>
                    {s.label}
                  </Link>
                </li>
              </Pill>
            ))}
          </ul>
        </nav>
        <ProjectFilter projects={projects} current={project} className="mt-2" href={(slug) => historyHref({ state, project: slug })} />
      </section>
      {page.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{before ? "No older tasks." : "No tasks yet."}</p>
      ) : (
        <ol className="divide-y rounded-lg border bg-card px-3">
          {page.map((t) => (
            <Row key={t.id} t={t} now={now} />
          ))}
        </ol>
      )}
      <div className="mt-3 flex items-center gap-4 text-sm">
        {before && (
          <Link href={historyHref({ state, project })} className="text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Newest
          </Link>
        )}
        {older && (
          <Link href={older} className="text-primary underline underline-offset-4">
            Older
          </Link>
        )}
      </div>
    </>
  );
}
