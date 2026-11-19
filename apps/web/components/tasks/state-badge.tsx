import { Ban, Check, CirclePause, Clock, Eye, Hourglass, Play, ShieldAlert, X, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import { STATE_HINT, STATE_TONE, type RelayState } from "@/lib/tasks";

const ICON: Record<RelayState, LucideIcon> = { waiting: Hourglass, queued: Clock, running: Play, review: Eye, held: ShieldAlert, blocked: CirclePause, done: Check, failed: X, closed: Ban };

/** A task's state mapped to {icon, tone, label, hint}; the rendering is components/ui/status-badge.tsx. */
export function TaskStateBadge({ state, className }: { state: RelayState; className?: string }) {
  return <StatusBadge icon={ICON[state]} tone={STATE_TONE[state]} label={state} title={STATE_HINT[state]} className={className} />;
}
