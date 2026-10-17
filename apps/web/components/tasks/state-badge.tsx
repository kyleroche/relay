import { Check, Clock, Eye, Globe, Lock, Play, X, type LucideIcon } from "lucide-react";
import type { PreviewState, TaskState } from "@relay/core";
import { STATE_HINT, STATE_TONE } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const ICON: Record<TaskState, LucideIcon> = { queued: Clock, claimed: Lock, running: Play, review: Eye, done: Check, failed: X };

/** A task's state as a word with an icon (DESIGN.md: status is never color alone); the hint sits in the title. */
export function TaskStateBadge({ state, className }: { state: TaskState; className?: string }) {
  const Icon = ICON[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded border border-current/40 px-1.5 py-px font-mono text-[11px] leading-4", STATE_TONE[state], className)} title={STATE_HINT[state]}>
      <Icon className="size-3" aria-hidden="true" />
      {state}
    </span>
  );
}

const PREVIEW: Record<Exclude<PreviewState, "none">, { label: string; tone: string; hint: string }> = {
  ready: { label: "preview ready", tone: "text-ok", hint: "The branch is built and deployed; the link opens it." },
  building: { label: "preview building", tone: "text-muted-foreground", hint: "A newer push is building; the link opens the last good build." },
  failed: { label: "preview failed", tone: "text-bad", hint: "The latest build failed; the link opens the last good build, the feed row the build log." },
};

/** The preview's state as a word with the globe icon; null when there is no preview to talk about. */
export function PreviewBadge({ state, className }: { state: PreviewState; className?: string }) {
  if (state === "none") return null;
  const p = PREVIEW[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded border border-current/40 px-1.5 py-px font-mono text-[11px] leading-4", p.tone, className)} title={p.hint}>
      <Globe className="size-3" aria-hidden="true" />
      {p.label}
    </span>
  );
}
