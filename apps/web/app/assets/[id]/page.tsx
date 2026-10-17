import type { Metadata } from "next";
import { ArrowUpRight, Download } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fmtDims, fmtSize, Thumb } from "@/components/assets/asset-card";
import { AssetViewer } from "@/components/assets/asset-viewer";
import { ReviewControls } from "@/components/assets/review-controls";
import { AssetStatusBadge } from "@/components/assets/status-badge";
import { ActorChip } from "@/components/feed/actor-chip";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Pill } from "@/components/ui/pill";
import { SectionHeading } from "@/components/ui/section-heading";
import { getAsset } from "@/lib/data";
import { fmtAgo, fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const d = await getAsset(id);
  if (!d) return { title: "Asset not found" };
  return { title: `${d.asset.title} (v${d.asset.version})`, description: d.asset.description ?? `${d.asset.kind} asset for ${d.asset.project ?? "relay"}`, robots: { index: false } };
}

export default async function AssetPage({ params }: Props) {
  const { id } = await params;
  const d = await getAsset(id);
  if (!d) notFound();
  const { asset, versions, task_url } = d;
  const now = Date.now();
  const dims = fmtDims(asset);
  const ref = asset.pr ? `PR #${asset.pr}` : asset.issue ? `issue #${asset.issue}` : null;
  const expires = asset.expires_at ? fmtDate(asset.expires_at) : null;

  return (
    <>
      <section className="py-6 sm:py-8">
        <Breadcrumb items={[{ label: "Assets", href: "/assets" }, ...(asset.project ? [{ label: asset.project, href: `/assets?project=${asset.project}` }] : [])]} />
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              {asset.title}
              <span className="font-mono text-base font-normal text-muted-foreground">v{asset.version}</span>
              <AssetStatusBadge status={asset.status} />
            </h1>
            {asset.description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{asset.description}</p>}
          </div>
          {task_url && (
            <a href={task_url} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 font-mono text-sm text-muted-foreground hover:text-primary">
              {ref} <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
          )}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex flex-col gap-4">
          <AssetViewer asset={asset} />
          {versions.length > 1 && (
            <section aria-labelledby="versions-h">
              <SectionHeading id="versions-h" count={versions.length} className="mb-2">
                Versions
              </SectionHeading>
              <ol className="flex gap-2 overflow-x-auto pb-1">
                {versions.map((v) => {
                  const current = v.id === asset.id;
                  return (
                    <li key={v.id} className="shrink-0">
                      <Link
                        href={`/assets/${v.id}`}
                        aria-current={current ? "page" : undefined}
                        className={cn("flex w-32 flex-col gap-1 rounded-md border p-1.5 text-left transition-colors hover:border-primary/50", current && "border-primary ring-1 ring-primary")}
                      >
                        <Thumb asset={{ thumb_url: v.thumb_url, kind: asset.kind, title: asset.title, url: null }} className="aspect-[16/10] rounded-sm" />
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
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <ReviewControls asset={asset} />
          {asset.review_note && (
            <div className={cn("rounded-md border p-3 text-sm", asset.status === "rejected" ? "border-bad/40 bg-bad/5" : "bg-card")}>
              <p className="text-[11px] text-muted-foreground">
                {asset.status === "rejected" ? "Rejected" : "Reviewed"} by {asset.reviewed_by} {asset.reviewed_at ? fmtAgo(asset.reviewed_at, now) : ""}
              </p>
              <p className="mt-1">{asset.review_note}</p>
              {asset.status === "rejected" && <p className="mt-2 text-[11px] text-muted-foreground">Recorded as a project decision; the next attempt reads it in its brief.</p>}
            </div>
          )}
          {!asset.review_note && asset.reviewed_by && (
            <p className="text-xs text-muted-foreground">
              {asset.status === "approved" || asset.status === "published" ? "Approved" : "Reviewed"} by {asset.reviewed_by}
              {asset.reviewed_at ? ` ${fmtAgo(asset.reviewed_at, now)}` : ""}.
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-[11px] text-muted-foreground">Made by</dt>
            <dd>
              <ActorChip actor={asset.created_by} />
            </dd>
            <dt className="text-[11px] text-muted-foreground">When</dt>
            <dd className="font-mono text-xs tabular-nums" title={asset.created_at}>
              {fmtAgo(asset.created_at, now)}
            </dd>
            {asset.project && (
              <>
                <dt className="text-[11px] text-muted-foreground">Project</dt>
                <dd>
                  <Link href={`/projects/${asset.project}`} className="text-primary underline underline-offset-4">{asset.project}</Link>
                  {ref && <span className="ml-1 font-mono text-xs text-muted-foreground">{ref}</span>}
                </dd>
              </>
            )}
            <dt className="text-[11px] text-muted-foreground">Kind</dt>
            <dd className="font-mono text-xs">
              {asset.kind} · {asset.mime}
            </dd>
            <dt className="text-[11px] text-muted-foreground">Size</dt>
            <dd className="font-mono text-xs">
              {fmtSize(asset.size)}
              {dims ? ` · ${dims}` : ""}
            </dd>
            <dt className="text-[11px] text-muted-foreground">SHA-256</dt>
            <dd className="truncate font-mono text-[11px] text-muted-foreground" title={asset.sha256}>
              {asset.sha256.slice(0, 16)}…
            </dd>
            <dt className="text-[11px] text-muted-foreground">Id</dt>
            <dd className="truncate font-mono text-[11px] text-muted-foreground">{asset.id}</dd>
            {expires && (
              <>
                <dt className="text-[11px] text-muted-foreground">Expires</dt>
                <dd className="font-mono text-xs">{expires}</dd>
              </>
            )}
            {asset.public_url && (
              <>
                <dt className="text-[11px] text-muted-foreground">Public URL</dt>
                <dd className="truncate">
                  <a href={asset.public_url} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-primary underline underline-offset-4">
                    {asset.public_url}
                  </a>
                </dd>
              </>
            )}
          </dl>
          {asset.tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Tags">
              {asset.tags.map((t) => (
                <Pill key={t} asChild mono>
                  <li>{t}</li>
                </Pill>
              ))}
            </ul>
          )}
          {asset.url && (
            <a href={asset.url} download className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
              <Download className="size-3.5" aria-hidden="true" /> Download original
            </a>
          )}
          <p className="text-[11px] text-muted-foreground">
            CLI: <code className="rounded bg-muted px-1 font-mono">relay asset review {asset.id.slice(0, 8)}… --approve</code>
          </p>
        </aside>
      </div>
    </>
  );
}
