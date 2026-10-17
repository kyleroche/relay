import { Check, Clock, TriangleAlert, type LucideIcon } from "lucide-react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import type { ModelStatus } from "@/lib/types";

/** A model's onboarding status mapped to {icon, tone, label, hint}; the rendering is components/ui/status-badge.tsx. */
const META: Record<ModelStatus, { label: string; tone: StatusTone; icon: LucideIcon; hint: string }> = {
  ready: { label: "onboarded", tone: "ok", icon: Check, hint: "Official vendor guidance is ingested and current." },
  stale: { label: "stale", tone: "warn", icon: TriangleAlert, hint: "The vendor docs changed since the last ingest; run relay onboard again." },
  pending: { label: "not onboarded", tone: "muted", icon: Clock, hint: "No vendor guidance ingested yet." },
};

export function ModelStatusBadge({ status }: { status: ModelStatus }) {
  const m = META[status];
  return <StatusBadge icon={m.icon} tone={m.tone} label={m.label} title={m.hint} />;
}
