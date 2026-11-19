import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { board } from "@relay/core";
import { Alert } from "@/components/alert";
import { HomeTabs } from "@/components/home-tabs";
import { ProjectFilter } from "@/components/board/project-filter";
import { Pill } from "@/components/ui/pill";
import { RelTime } from "@/components/ui/rel-time";
import { boardProblem } from "@/lib/board";
import { recentTasks } from "@/lib/board-read";
import { getProjects } from "@/lib/data";
import { STATE_HINT, STATE_TONE, taskPagePath, type RelayState } from "@/lib/tasks";

/**
 * The archive behind the board (DESIGN.md, "Board"): every task on the team's board newest first, one row each. The
 * board's Done column shows the newest ten and links here. Filters are pills in the URL (state, project). The board
 * reads threads by latest activity one queue at a time, so "Older" pages one project back with the board's own cursor
 * and, across projects, this is the newest page only. A row links to the
 * task's page; there is nothing to decide here, the board is for that.
 */

export const HISTORY_METADATA: Metadata = {
  title: "History",
  description: "Every task relay has run, newest first: merged, closed, failed and the ones still moving, with the lane, the model and the pull request.",
  alternates: { canonical: "/history" },
  robots: { index: false },
};

export type HistorySearch = { state?: string; project?: string; before?: string };

const PAGE = 50;

const isState = (s: string | undefined): s is RelayState => !!s && (board.RELAY_STATES as readonly string[]).includes(s);

function historyHref(q: { state?: string; project?: string; before?: string }): string {
  const qs = new URLSearchParams();
  if (q.state) qs.set("state", q.state);
  if (q.project) qs.set("project", q.project);
  if (q.before) qs.set("before", q.before);
  const s = qs.toString();
  return s ? `/history?${s}` : "/history";
}

function Row({ t, now }: { t: board.BoardTask; now: number }) {
  const said = t.state === "failed" || t.state === "closed" ? t.reason : t.state === "done" ? t.result : null;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
      <div className="hidden sm:block">
        <Pill tone={STATE_TONE[t.state]} title={STATE_HINT[t.state]}>
          {t.state}
        </Pill>
      </div>
      <div className="min-w-0">
        <Link href={taskPagePath(t.id)} className="line-clamp-1 font-medium hover:text-primary">
          {t.title || t.id}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Pill tone={STATE_TONE[t.state]} size="sm" className="sm:hidden">
            {t.state}
          </Pill>
          <span className="font-mono">{t.project ?? t.channel}</span>
          {t.lane && (
            <Pill mono size="sm">
              {t.lane}
            </Pill>
          )}
          {t.model && <span className="font-mono">{t.model}</span>}
          {t.pr && (
            <a href={t.pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-primary">
              PR #{t.pr.number} <ArrowUpRight className="size-3" aria-hidden="true" />
            </a>
          )}
          {said && <span className={t.state === "failed" ? "line-clamp-1 text-bad" : "line-clamp-1"}>{said}</span>}
        </p>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <RelTime iso={t.created_at} now={now} />
      </div>
    </li>
  );
}

export async function HistoryPage({ searchParams }: { searchParams: Promise<HistorySearch> }) {
  const q = await searchParams;
  const state = isState(q.state) ? q.state : undefined;
  const project = q.project || undefined;
  const before = q.before || undefined;
  const [read, projects] = await Promise.all([
    recentTasks({ limit: PAGE, ...(project ? { project, ...(before ? { before } : {}) } : {}), ...(state ? { states: [state] } : {}) }).then(
      (r) => ({ ...r, problem: null }),
      (e: unknown) => ({ tasks: [], older: null, problem: boardProblem(e) }),
    ),
    getProjects(),
  ]);
  const now = Date.now();
  const page = read.tasks;
  const older = read.older ? historyHref({ state, project, before: read.older }) : null;
  const states: Array<{ key: string; label: string }> = [{ key: "", label: "All" }, ...board.RELAY_STATES.map((s) => ({ key: s, label: s }))];

  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="sr-only">History</h1>
        <HomeTabs active="history" />
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Every task on the board, newest first: what merged, what was closed, what failed, and what is still moving. The board shows the newest ten done; this is the rest.</p>
        <nav aria-label="State filter" className="mt-2">
          <ul className="flex flex-wrap items-center gap-1">
            {states.map((s) => (
              <Pill key={s.key || "all"} asChild mono={!!s.key} tone={(state ?? "") === s.key ? "primary" : "muted"} className="hover:text-foreground">
                <li>
                  <Link href={historyHref({ state: s.key || undefined, project })} aria-current={(state ?? "") === s.key ? "true" : undefined} title={s.key ? STATE_HINT[s.key as RelayState] : undefined}>
                    {s.label}
                  </Link>
                </li>
              </Pill>
            ))}
          </ul>
        </nav>
        <ProjectFilter projects={projects} current={project} className="mt-2" href={(slug) => historyHref({ state, project: slug })} />
      </section>
      {read.problem ? (
        <Alert tone="bad">The board could not be read. {read.problem}</Alert>
      ) : page.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{before ? "No older tasks." : "No tasks yet."}</p>
      ) : (
        <ol className="divide-y rounded-lg border bg-card px-3">
          {page.map((t) => (
            <Row key={t.id} t={t} now={now} />
          ))}
        </ol>
      )}
      {!project && !read.problem && page.length >= PAGE && <p className="mt-2 text-xs text-muted-foreground">Across projects this is the newest {PAGE}. Pick a project to page further back.</p>}
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
