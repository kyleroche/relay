import { Check, Clock, Globe, History, X, type LucideIcon } from "lucide-react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import type { AssetStatus } from "@/lib/types";

/** An asset's status mapped to {icon, tone, label, hint}; the rendering is components/ui/status-badge.tsx. */
const STATUS: Record<AssetStatus, { label: string; tone: StatusTone; icon: LucideIcon; hint: string }> = {
  pending: { label: "needs review", tone: "warn", icon: Clock, hint: "Uploaded and waiting for a yes or a no." },
  approved: { label: "approved", tone: "ok", icon: Check, hint: "Approved; the task was told." },
  rejected: { label: "rejected", tone: "bad", icon: X, hint: "Rejected with a note; the note is a project decision." },
  superseded: { label: "superseded", tone: "muted", icon: History, hint: "A newer version replaced this one." },
  published: { label: "published", tone: "primary", icon: Globe, hint: "Copied to the public store at a permanent URL." },
};

export function AssetStatusBadge({ status, className }: { status: AssetStatus; className?: string }) {
  const s = STATUS[status];
  return <StatusBadge icon={s.icon} tone={s.tone} label={s.label} title={s.hint} className={className} />;
}
