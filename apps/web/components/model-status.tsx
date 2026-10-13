import { Check, Clock, TriangleAlert } from "lucide-react";
import type { ModelStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const META: Record<ModelStatus, { label: string; className: string; Icon: typeof Check }> = {
  ready: { label: "onboarded", className: "text-ok", Icon: Check },
  stale: { label: "stale", className: "text-warn", Icon: TriangleAlert },
  pending: { label: "not onboarded", className: "text-muted-foreground", Icon: Clock },
};

/** Status always ships with an icon and a label, never color alone. */
export function ModelStatusBadge({ status }: { status: ModelStatus }) {
  const m = META[status];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-[11px]", m.className)}>
      <m.Icon className="size-3" aria-hidden="true" />
      {m.label}
    </span>
  );
}
