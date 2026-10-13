import { Check, Clock, Globe, History, X } from "lucide-react";
import type { AssetStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Status with an icon and a label, never color alone (DESIGN.md). */
const STATUS: Record<AssetStatus, { label: string; className: string; Icon: typeof Check }> = {
  pending: { label: "needs review", className: "text-warn border-warn/40 bg-warn/10", Icon: Clock },
  approved: { label: "approved", className: "text-ok border-ok/40 bg-ok/10", Icon: Check },
  rejected: { label: "rejected", className: "text-bad border-bad/40 bg-bad/10", Icon: X },
  superseded: { label: "superseded", className: "text-muted-foreground border-border bg-muted", Icon: History },
  published: { label: "published", className: "text-primary border-primary/40 bg-primary/10", Icon: Globe },
};

export function StatusBadge({ status, className }: { status: AssetStatus; className?: string }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none", s.className, className)}>
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </span>
  );
}
