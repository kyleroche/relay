import type { Metadata } from "next";
import Link from "next/link";
import { Feed } from "@/components/feed/feed";
import { JsonLd, organizationLd, softwareApplicationLd } from "@/components/seo/json-ld";
import { getFeed, getProjects } from "@/lib/data";
import { viewerTimeZone } from "@/lib/tz-server";

export const metadata: Metadata = {
  title: { absolute: "relay — feed of everything your coding agents did" },
  description:
    "The relay feed: every issue, run, model call, pull request, review and deployment across your coding-agent subscriptions, with tokens and cost, newest first.",
  alternates: { canonical: "/" },
};

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function FeedPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const filters = {
    project: one(sp.project),
    lane: one(sp.lane),
    actor: one(sp.actor),
    kind: one(sp.kind),
  };
  const [events, projects, allRecent, tz] = await Promise.all([
    getFeed({ ...filters, limit: 150 }),
    getProjects(),
    getFeed({ limit: 300 }),
    viewerTimeZone(),
  ]);
  const actors = [...new Set(allRecent.map((e) => e.actor))].sort();
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = allRecent.filter((e) => e.ts.slice(0, 10) === today).length;
  const todayCost = allRecent.filter((e) => e.ts.slice(0, 10) === today).reduce((s, e) => s + e.cost_equiv, 0);

  return (
    <>
      <JsonLd data={[softwareApplicationLd(), organizationLd()]} />
      <section className="py-6 sm:py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Everything humans, bots, runners and agents did across your coding-agent subscriptions, newest first. relay
              records each GitHub issue, run, model call, pull request, review and deployment as one append-only event with
              its tokens and cost equivalent. New here? Read <Link href="/info" className="text-primary underline underline-offset-4">what relay is</Link>,
              browse the <Link href="/docs" className="text-primary underline underline-offset-4">docs</Link>, or use the{" "}
              <Link href="/docs/api" className="text-primary underline underline-offset-4">API</Link>.
            </p>
          </div>
          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Today</dt>
              <dd className="font-mono tabular-nums">{todayCount} events</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Cost equivalent</dt>
              <dd className="font-mono tabular-nums">${todayCost.toFixed(2)}</dd>
            </div>
          </dl>
        </div>
      </section>
      <Feed events={events} projects={projects.map((p) => p.slug)} actors={actors} filters={filters} tz={tz} />
    </>
  );
}
