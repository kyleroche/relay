import { Download, FileText, File as FileIcon, Music } from "lucide-react";
import { fmtSize } from "@/components/assets/asset-card";
import type { Asset } from "@/lib/types";

/**
 * One viewer per kind. Images and video load from the signed URL; PDFs in an iframe; HTML (a bare file or a zip
 * bundle served entry by entry) in an iframe with sandbox="allow-scripts" and no allow-same-origin, so bundle scripts
 * run in an opaque origin and cannot reach this app's cookies or DOM. Anything else is a download link.
 */
export function AssetViewer({ asset }: { asset: Asset }) {
  const frame = "w-full overflow-hidden rounded-md border bg-muted";
  if (asset.kind === "image") {
    if (!asset.url) return <Unavailable asset={asset} />;
    return (
      <figure className={`${frame} flex items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0_25%,var(--card)_0_50%)] bg-[length:16px_16px]`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL */}
        <img src={asset.url} alt={asset.description ?? asset.title} className="max-h-[70vh] w-auto max-w-full object-contain" width={asset.width ?? undefined} height={asset.height ?? undefined} />
      </figure>
    );
  }
  if (asset.kind === "video") {
    if (!asset.url) return <Unavailable asset={asset} />;
    return (
      <div className={`${frame} flex items-center justify-center bg-black`}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- agent output, no transcript */}
        <video src={asset.url} poster={asset.thumb_url ?? undefined} controls preload="metadata" playsInline className="max-h-[70vh] w-auto max-w-full" />
      </div>
    );
  }
  if (asset.kind === "audio") {
    if (!asset.url) return <Unavailable asset={asset} />;
    return (
      <div className={`${frame} flex flex-col items-center gap-4 p-8`}>
        <Music className="size-10 text-muted-foreground/60" aria-hidden="true" />
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- agent output, no transcript */}
        <audio src={asset.url} controls preload="metadata" className="w-full max-w-md" />
      </div>
    );
  }
  if (asset.kind === "pdf") {
    if (!asset.url) return <Unavailable asset={asset} />;
    return <iframe src={asset.url} title={asset.title} className={`${frame} h-[75vh]`} />;
  }
  if (asset.kind === "html") {
    const src = asset.bundle_url ?? asset.url;
    if (!src) return <Unavailable asset={asset} />;
    return (
      <div className="flex flex-col gap-1">
        <iframe src={src} title={asset.title} sandbox="allow-scripts" referrerPolicy="no-referrer" className={`${frame} h-[75vh] bg-white`} />
        <p className="text-[11px] text-muted-foreground">Rendered in a sandboxed frame (scripts allowed, origin isolated). Links inside do not open.</p>
      </div>
    );
  }
  return (
    <div className={`${frame} flex flex-col items-center gap-3 p-8 text-center`}>
      {asset.mime.startsWith("text/") ? <FileText className="size-10 text-muted-foreground/60" aria-hidden="true" /> : <FileIcon className="size-10 text-muted-foreground/60" aria-hidden="true" />}
      <p className="text-sm text-muted-foreground">
        {asset.mime} · {fmtSize(asset.size)}. No inline viewer for this kind.
      </p>
      {asset.url && (
        <a href={asset.url} download className="inline-flex items-center gap-1.5 text-sm text-primary underline underline-offset-4">
          <Download className="size-3.5" aria-hidden="true" /> Download
        </a>
      )}
    </div>
  );
}

function Unavailable({ asset }: { asset: Asset }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border bg-muted p-8 text-center">
      {asset.thumb_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
        <img src={asset.thumb_url} alt="" className="max-h-[50vh] w-auto max-w-full rounded object-contain" />
      ) : (
        <FileIcon className="size-10 text-muted-foreground/60" aria-hidden="true" />
      )}
      <p className="text-sm text-muted-foreground">The store cannot serve these bytes right now{asset.thumb_url ? "; showing the poster" : ""}.</p>
    </div>
  );
}
