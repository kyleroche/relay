import { Check, Clock, Eye, Globe, Lock, Play, X, type LucideIcon } from "lucide-react";
import type { PreviewState, TaskState } from "@relay/core";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { STATE_HINT, STATE_TONE } from "@/lib/tasks";

const ICON: Record<TaskState, LucideIcon> = { queued: Clock, claimed: Lock, running: Play, review: Eye, done: Check, failed: X };

/** A task's state mapped to {icon, tone, label, hint}; the rendering is components/ui/status-badge.tsx. */
export function TaskStateBadge({ state, className }: { state: TaskState; className?: string }) {
  return <StatusBadge icon={ICON[state]} tone={STATE_TONE[state]} label={state} title={STATE_HINT[state]} className={className} />;
}

const PREVIEW: Record<Exclude<PreviewState, "none">, { label: string; tone: StatusTone; hint: string }> = {
  ready: { label: "preview ready", tone: "ok", hint: "The branch is built and deployed; the link opens it." },
  building: { label: "preview building", tone: "muted", hint: "A newer push is building; the link opens the last good build." },
  failed: { label: "preview failed", tone: "bad", hint: "The latest build failed; the link opens the last good build, the feed row the build log." },
};

/** The preview's state with the globe icon; null when there is no preview to talk about. */
export function PreviewBadge({ state, className }: { state: PreviewState; className?: string }) {
  if (state === "none") return null;
  const p = PREVIEW[state];
  return <StatusBadge icon={Globe} tone={p.tone} label={p.label} title={p.hint} className={className} />;
}
