import type { Metadata } from "next";
import Link from "next/link";
import { CoverageBar } from "@/components/coverage-bar";
import { PageIntro } from "@/components/page-intro";
import { getProjects } from "@/lib/data";
import { fmtAgo } from "@/lib/format";

export const metadata: Metadata = {
  title: "Projects",
  description: "Repositories linked to relay: last activity, open issues, current decisions and digest coverage.",
  alternates: { canonical: "/projects" },
};

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await getProjects();
  const now = Date.now();
  return (
    <>
      <section className="py-6 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <PageIntro doc="/docs/memory">
          Repositories linked with <code className="rounded bg-muted px-1 font-mono text-xs">relay link</code>, with their decisions and digest coverage.
        </PageIntro>
      </section>
      {projects.length === 0 && (
        <div className="rounded-md border border-dashed p-6 sm:p-10">
          <h2 className="text-base font-medium">No projects linked</h2>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">Run this in a repository on a machine with your coding-agent logins; it registers the project and writes its summary.</p>
          <pre className="mt-4 overflow-x-auto rounded-md border bg-card p-3 font-mono text-xs leading-5">
            <code className="language-bash">npx @kyleroche/relay link</code>
          </pre>
        </div>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {projects.map((p) => (
          <li key={p.slug}>
            <Link
              href={`/projects/${p.slug}`}
              className="flex h-full flex-col gap-3 rounded-md border bg-card p-4 transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-medium">{p.slug}</h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">{p.repo}</p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={p.lastActivity ?? ""}>
                  {p.lastActivity ? fmtAgo(p.lastActivity, now) : "no activity"}
                </span>
              </div>
              {p.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{p.summary}</p>}
              <dl className="mt-auto grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-[11px] text-muted-foreground">Open issues</dt>
                  <dd className="font-mono tabular-nums">{p.openIssues}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Decisions</dt>
                  <dd className="font-mono tabular-nums">{p.decisionsCount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Digest coverage</dt>
                  <dd>
                    <CoverageBar digested={p.digest.digested} total={p.digest.total} />
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-1">
                {p.lanes.map((l) => (
                  <span key={l} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title={`Issues labelled agent:${l} run on this lane`}>
                    {l}
                  </span>
                ))}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
