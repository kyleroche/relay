import { cn } from "@/lib/utils";

/** Digest coverage: files with a current summary over files seen. One hue, fill carries magnitude. */
export function CoverageBar({ digested, total, className, showLabel = true }: { digested: number; total: number; className?: string; showLabel?: boolean }) {
  const pct = total ? Math.round((digested / total) * 100) : 0;
  return (
    <div className={cn("flex items-center gap-2", className)} title={`${digested} of ${total} files digested`}>
      <div className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Digest coverage">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      {showLabel && <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{pct}%</span>}
    </div>
  );
}
