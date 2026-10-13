import {
  BookOpen,
  Check,
  CircleCheck,
  CircleDot,
  Cpu,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Globe,
  Layers,
  Lightbulb,
  Play,
  Tag,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { kindInfo } from "@/lib/events";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  "issue.opened": CircleDot,
  "issue.labeled": Tag,
  "issue.closed": CircleCheck,
  "run.started": Play,
  "run.finished": Check,
  "run.failed": TriangleAlert,
  "step.usage": Cpu,
  "pr.opened": GitPullRequest,
  "pr.review": Eye,
  "pr.merged": GitMerge,
  "pr.closed": GitPullRequestClosed,
  "workflow.run": Workflow,
  "preview.ready": Globe,
  "preview.failed": TriangleAlert,
  "decision.captured": Lightbulb,
  "memory.consolidated": Layers,
  "onboard.refreshed": BookOpen,
};

const TONE: Record<string, string> = {
  "run.failed": "text-bad",
  "preview.failed": "text-bad",
  "pr.merged": "text-ok",
  "preview.ready": "text-ok",
  "issue.closed": "text-ok",
};

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[kind] ?? CircleDot;
  const info = kindInfo(kind);
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", TONE[kind], className)} aria-label={info.label} role="img" />;
}
