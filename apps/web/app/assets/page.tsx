import type { Metadata } from "next";
import Link from "next/link";
import { AssetCard } from "@/components/assets/asset-card";
import { AssetFilters } from "@/components/assets/asset-filters";
import { getAssets, getProjects } from "@/lib/data";
import { ASSET_KINDS, ASSET_STATUSES, type Asset, type AssetKind, type AssetStatus } from "@/lib/types";

export const metadata: Metadata = {
  title: "Assets",
  description: "Media your coding agents produced: mockups, renders, clips and documents, versioned, with an approve-or-reject review loop that writes back to the task.",
  alternates: { canonical: "/assets" },
};

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function AssetsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const project = one(sp.project);
  const statusRaw = one(sp.status);
  const kindRaw = one(sp.kind);
  const status = ASSET_STATUSES.includes(statusRaw as AssetStatus) ? (statusRaw as AssetStatus) : undefined;
  const kind = ASSET_KINDS.includes(kindRaw as AssetKind) ? (kindRaw as AssetKind) : undefined;
  const [assets, projects] = await Promise.all([
    getAssets({ ...(project ? { project } : {}), ...(status ? { status } : {}), ...(kind ? { kind } : {}), limit: 200 }),
    getProjects(),
  ]);
  const now = Date.now();
  const pending = assets.filter((a) => a.status === "pending");
  const rest = assets.filter((a) => a.status !== "pending");
  const byProject = new Map<string, Asset[]>();
  for (const a of rest) {
    const k = a.project ?? "no project";
    byProject.set(k, [...(byProject.get(k) ?? []), a]);
  }
  const anyFilter = Boolean(project || status || kind);

  return (
    <>
      <section className="py-6 sm:py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Things agents make that are not code: mockups, renders, clips, documents. Each one is stored privately, versioned, and
              waits here for a yes or a no. A rejection note becomes a decision in the project&apos;s memory and reopens the task, so
              the next attempt starts from it. The visual counterpart of a pull request.
            </p>
          </div>
          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Needs review</dt>
              <dd className="font-mono tabular-nums">{pending.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Shown</dt>
              <dd className="font-mono tabular-nums">{assets.length}</dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="flex flex-col gap-6">
        <AssetFilters filters={{ project, status, kind }} projects={projects.map((p) => p.slug)} />

        {assets.length === 0 && (
          <div className="rounded-md border border-dashed p-6 sm:p-10">
            <h2 className="text-base font-medium">{anyFilter ? "Nothing matches these filters" : "No assets yet"}</h2>
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">
              {anyFilter
                ? "Widen the filters. Rejected and superseded versions are kept for the retention window, then removed."
                : "Assets arrive from the CLI, the API, or an agent's MCP tool. Each upload writes an asset.uploaded event and lands here as pending."}
            </p>
            {!anyFilter && (
              <pre className="mt-4 overflow-x-auto rounded-md border bg-card p-3 font-mono text-xs leading-5">
                <code className="language-bash">{`pnpm relay asset put ./render.png --project <slug> --issue 42 --title "Hero render"
curl -X POST -H "Authorization: Bearer $TOKEN" -F file=@render.png -F project=<slug> -F issue=42 /api/v1/assets`}</code>
              </pre>
            )}
          </div>
        )}

        {pending.length > 0 && (
          <section aria-labelledby="pending-h">
            <h2 id="pending-h" className="mb-2 flex items-baseline gap-2 text-sm font-medium">
              Needs review
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{pending.length}</span>
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                open one, then <kbd className="rounded border bg-muted px-1 font-mono">a</kbd> approve / <kbd className="rounded border bg-muted px-1 font-mono">r</kbd> reject
              </span>
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pending.map((a) => (
                <AssetCard key={a.id} asset={a} now={now} />
              ))}
            </ul>
          </section>
        )}

        {[...byProject.entries()].map(([slug, list]) => (
          <section key={slug} aria-labelledby={`p-${slug}`}>
            <h2 id={`p-${slug}`} className="mb-2 flex items-baseline gap-2 text-sm font-medium">
              {slug === "no project" ? (
                slug
              ) : (
                <Link href={`/projects/${slug}`} className="hover:text-primary">
                  {slug}
                </Link>
              )}
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{list.length}</span>
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((a) => (
                <AssetCard key={a.id} asset={a} now={now} showProject={false} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
