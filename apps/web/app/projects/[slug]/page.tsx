import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { CoverageBar } from "@/components/coverage-bar";
import { EventRow } from "@/components/feed/event-row";
import { ModelStatusBadge } from "@/components/model-status";
import { getProject } from "@/lib/data";
import { fmtAgo, fmtDate } from "@/lib/format";
import { dayKeyIn, dayLabelIn } from "@/lib/tz";
import { viewerTimeZone } from "@/lib/tz-server";

type Props = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const p = await getProject(slug);
  if (!p) return { title: "Project not found" };
  return {
    title: p.slug,
    description: p.summary ?? `relay project ${p.slug} (${p.repo})`,
    alternates: { canonical: `/projects/${p.slug}` },
  };
}

export default async function ProjectPage({ params }: Props) {
  const { slug } = await params;
  const [p, tz] = await Promise.all([getProject(slug), viewerTimeZone()]);
  if (!p) notFound();
  const now = Date.now();
  const groups: Array<{ key: string; label: string; items: typeof p.events }> = [];
  for (const e of p.events) {
    const key = dayKeyIn(e.ts, tz);
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(e);
    else groups.push({ key, label: dayLabelIn(e.ts, tz, now), items: [e] });
  }

  return (
    <>
      <section className="py-6 sm:py-10">
        <p className="text-xs text-muted-foreground">
          <Link href="/projects" className="hover:text-foreground">Projects</Link> / {p.slug}
        </p>
        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{p.slug}</h1>
            <a
              href={`https://github.com/${p.repo}`}
              className="mt-1 inline-flex items-center gap-1 font-mono text-sm text-muted-foreground hover:text-primary"
              rel="noopener noreferrer"
              target="_blank"
            >
              {p.repo} <ArrowUpRight className="size-3.5" />
            </a>
            {p.summary && <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">{p.summary}</p>}
          </div>
          <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-1">
            <div>
              <dt className="text-[11px] text-muted-foreground">Last activity</dt>
              <dd className="font-mono tabular-nums">{p.lastActivity ? fmtAgo(p.lastActivity, now) : "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Open issues</dt>
              <dd className="font-mono tabular-nums">{p.openIssues}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Stack</dt>
              <dd>{p.stack ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Check</dt>
              <dd className="font-mono text-xs">{p.check_cmd ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Digest coverage</dt>
              <dd>
                <CoverageBar digested={p.digest.digested} total={p.digest.total} />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {p.digest.digested} / {p.digest.total} files
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-10">
          <section aria-labelledby="decisions">
            <h2 id="decisions" className="text-lg font-semibold tracking-tight">
              Current decisions <span className="ml-1 font-mono text-sm font-normal text-muted-foreground">{p.decisions.length}</span>
            </h2>
            {p.decisions.length === 0 ? (
              <p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No decisions captured yet. They are extracted when a PR merges and from session-end hooks.
              </p>
            ) : (
              <ol className="mt-4 flex flex-col divide-y">
                {p.decisions.map((d) => (
                  <li key={d.id} className="flex flex-col gap-1 py-3">
                    <p className="text-[15px] leading-6">{d.text}</p>
                    <p className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
                      <span>#{d.id}</span>
                      <span>·</span>
                      <span>source {d.source}</span>
                      {d.source_ref && (
                        <>
                          <span>·</span>
                          {d.source_ref.startsWith("http") ? (
                            <a href={d.source_ref} className="hover:text-primary" rel="noopener noreferrer" target="_blank">
                              {d.source_ref.replace("https://github.com/", "")}
                            </a>
                          ) : (
                            <span>{d.source_ref}</span>
                          )}
                        </>
                      )}
                      <span>·</span>
                      <time dateTime={d.valid_from}>{fmtDate(d.valid_from)}</time>
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="timeline">
            <h2 id="timeline" className="flex items-baseline gap-3 text-lg font-semibold tracking-tight">
              Timeline
              <Link href={`/?project=${p.slug}`} className="text-xs font-normal text-primary underline underline-offset-4">
                Open in the feed
              </Link>
            </h2>
            <div className="mt-4 flex flex-col gap-4">
              {groups.map((g) => (
                <div key={g.key}>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">{g.label}</h3>
                  <ul className="-mx-2 divide-y divide-border/60">
                    {g.items.map((e) => (
                      <EventRow key={e.id} event={e} tz={tz} showProject={false} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-8">
          <section aria-labelledby="models">
            <h2 id="models" className="text-lg font-semibold tracking-tight">Models in use</h2>
            <ul className="mt-4 flex flex-col gap-3">
              {p.models.map((m) => (
                <li key={m.id} className="rounded-md border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs">{m.id}</span>
                    <ModelStatusBadge status={m.status} />
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    {m.guidance_count} guidance · {m.skill_count} skills
                    {m.onboarded_at && <> · onboarded {fmtAgo(m.onboarded_at, now)}</>}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">lanes: {m.lanes.join(", ")}</p>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="lanes">
            <h2 id="lanes" className="text-lg font-semibold tracking-tight">Lanes</h2>
            <p className="mt-1 text-sm text-muted-foreground">Labels on an issue that route it to a runner with that login.</p>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {p.lanes.map((l) => (
                <li key={l}>
                  <Link href={`/?project=${p.slug}&lane=${l}`} className="rounded border bg-muted px-2 py-0.5 font-mono text-xs hover:border-primary/50">
                    agent:{l}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
