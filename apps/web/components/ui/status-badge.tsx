import type { LucideIcon } from "lucide-react";
import { Pill, type PillTone } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export type { PillTone as StatusTone };

/**
 * One status: an icon, a word and a tone, never color alone (DESIGN.md). The hint goes in `title`. Domains map their
 * value to {icon, tone, label} in a thin wrapper (components/assets/status-badge.tsx, components/tasks/state-badge.tsx,
 * components/model-status.tsx, the worker status on app/workers/page.tsx) and render this.
 */
export function StatusBadge({ icon: Icon, tone, label, title, className, iconClassName }: { icon: LucideIcon; tone: PillTone; label: string; title?: string; className?: string; iconClassName?: string }) {
  return (
    <Pill tone={tone} title={title} className={cn("gap-1", className)}>
      <Icon className={iconClassName} aria-hidden="true" />
      {label}
    </Pill>
  );
}
