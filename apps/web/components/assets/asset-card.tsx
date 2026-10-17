import { FileText, File as FileIcon, Film, Globe, Image as ImageIcon, Music } from "lucide-react";
import Link from "next/link";
import { ActorChip } from "@/components/feed/actor-chip";
import { AssetStatusBadge } from "@/components/assets/status-badge";
import { Pill } from "@/components/ui/pill";
import { fmtAgo } from "@/lib/format";
import type { Asset, AssetKind } from "@/lib/types";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<AssetKind, typeof FileIcon> = { image: ImageIcon, video: Film, audio: Music, pdf: FileText, html: Globe, file: FileIcon };

export function fmtSize(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fmtDims(a: Pick<Asset, "width" | "height" | "duration_ms">): string | null {
  const parts: string[] = [];
  if (a.width && a.height) parts.push(`${a.width}×${a.height}`);
  if (a.duration_ms) parts.push(`${(a.duration_ms / 1000).toFixed(a.duration_ms >= 60_000 ? 0 : 1)}s`);
  return parts.length ? parts.join(" · ") : null;
}

/** Thumbnail when the store rendered one; otherwise the kind's icon on a quiet surface. */
export function Thumb({ asset, className, large = false }: { asset: Pick<Asset, "thumb_url" | "kind" | "title" | "url">; className?: string; large?: boolean }) {
  const Icon = KIND_ICON[asset.kind];
  const src = asset.thumb_url ?? (asset.kind === "image" ? asset.url : null);
  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden bg-muted", className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URLs from the store; not optimisable
        <img src={src} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <Icon className={cn("text-muted-foreground/60", large ? "size-10" : "size-6")} aria-hidden="true" />
      )}
      {asset.kind === "video" && (
        <Pill size="sm" className="absolute bottom-1.5 right-1.5 border-transparent bg-background/85 text-foreground backdrop-blur">
          <Film aria-hidden="true" /> video
        </Pill>
      )}
    </div>
  );
}

export function AssetCard({ asset, now, showProject = true }: { asset: Asset; now: number; showProject?: boolean }) {
  const dims = fmtDims(asset);
  const ref = asset.pr ? `PR #${asset.pr}` : asset.issue ? `#${asset.issue}` : null;
  return (
    <li>
      <Link
        href={`/assets/${asset.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-md border bg-card transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`${asset.title}, ${asset.status}`}
      >
        <Thumb asset={asset} className="aspect-[16/10] w-full border-b" />
        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-sm font-medium leading-5">{asset.title}</h3>
            <AssetStatusBadge status={asset.status} className="shrink-0" />
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {showProject && asset.project && <span>{asset.project}</span>}
            {ref && <span className="font-mono">{ref}</span>}
            <span className="font-mono">v{asset.version}</span>
            <span>{asset.kind}</span>
            {dims && <span className="hidden font-mono sm:inline">{dims}</span>}
            <span className="font-mono">{fmtSize(asset.size)}</span>
          </p>
          <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[11px] text-muted-foreground">
            <ActorChip actor={asset.created_by} />
            <time dateTime={asset.created_at} title={asset.created_at} className="font-mono tabular-nums">
              {fmtAgo(asset.created_at, now)}
            </time>
          </div>
        </div>
      </Link>
    </li>
  );
}
