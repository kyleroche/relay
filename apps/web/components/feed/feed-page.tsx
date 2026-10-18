import type { Metadata } from "next";
import Link from "next/link";
import { Feed } from "@/components/feed/feed";
import { HomeTabs } from "@/components/home-tabs";
import { getAssets, getFeed, getProjects, getTasks, getWorkers } from "@/lib/data";
import { viewerTimeZone } from "@/lib/tz-server";

/** The feed, the second tab of the signed-in home: `app/feed/page.tsx` renders it; the board at / is the first tab. */

export const FEED_METADATA: Metadata = {
  title: { absolute: "relay — feed of everything your coding agents did" },
  description:
    "The relay feed: every issue, run, model call, pull request, review and deployment across your coding-agent subscriptions, with tokens and cost, newest first.",
  alternates: { canonical: "/feed" },
};

export type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function FeedPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const filters = {
    project: one(sp.project),
    lane: one(sp.lane),
    actor: one(sp.actor),
    kind: one(sp.kind),
  };
  const [events, projects, allRecent, pending, review, held, workers, tz] = await Promise.all([
    getFeed({ ...filters, limit: 150 }),
    getProjects(),
    getFeed({ limit: 300 }),
    getAssets({ status: "pending", limit: 50 }),
    getTasks({ state: "review", limit: 50 }),
    getTasks({ state: "held", limit: 50 }),
    getWorkers(),
    viewerTimeZone(),
  ]);
  const actors = [...new Set(allRecent.map((e) => e.actor))].sort();
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = allRecent.filter((e) => e.ts.slice(0, 10) === today).length;
  const todayCost = allRecent.filter((e) => e.ts.slice(0, 10) === today).reduce((s, e) => s + e.cost_equiv, 0);
  const offline = workers.filter((w) => !w.retired && w.status === "offline").length;
  const waiting = review.length + held.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <>
      <section className="py-6 sm:py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="sr-only">Feed</h1>
            <HomeTabs active="feed" />
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Everything humans, bots, workers and agents did across your coding-agent subscriptions, newest first. relay
              records each GitHub issue, run, model call, pull request, review and deployment as one append-only event with
              its tokens and cost equivalent. Decisions are made on the board.
            </p>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Today</dt>
              <dd className="font-mono tabular-nums">{todayCount} events</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Cost equivalent</dt>
              <dd className="font-mono tabular-nums">${todayCost.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Waiting on you</dt>
              <dd className="font-mono tabular-nums">
                {waiting > 0 ? (
                  <Link href="/" className="text-warn underline underline-offset-4" title={`${review.length} in review, ${held.length} held; decide on the board`}>
                    {plural(waiting, "task")}
                  </Link>
                ) : (
                  plural(0, "task")
                )}
                <span className="text-muted-foreground"> · </span>
                {pending.length > 0 ? (
                  <Link href="/assets?status=pending" className="text-warn underline underline-offset-4">
                    {plural(pending.length, "asset")}
                  </Link>
                ) : (
                  plural(0, "asset")
                )}
              </dd>
            </div>
            {offline > 0 && (
              <div>
                <dt className="text-xs text-muted-foreground">Workers</dt>
                <dd className="font-mono tabular-nums">
                  <Link href="/workers" className="text-warn underline underline-offset-4">
                    {plural(offline, "worker")} offline
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </div>
      </section>
      <Feed events={events} projects={projects.map((p) => p.slug)} actors={actors} filters={filters} tz={tz} />
    </>
  );
}
