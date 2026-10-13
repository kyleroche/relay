import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { ActorChip } from "@/components/feed/actor-chip";
import { KindIcon } from "@/components/feed/kind-icon";
import { kindInfo } from "@/lib/events";
import { fmtCost, fmtDuration, fmtTokens } from "@/lib/format";
import { clockIn } from "@/lib/tz";
import type { FeedEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

function metrics(e: FeedEvent): string | null {
  if (e.kind === "step.usage") {
    const ctx = e.tokens_in + e.cache_read;
    return `${fmtTokens(ctx)} ctx · ${fmtTokens(e.tokens_out)} out · ${fmtCost(e.cost_equiv)}`;
  }
  if (e.kind === "memory.consolidated" && e.tokens_in) return `${fmtTokens(e.tokens_in + e.cache_read)} ctx`;
  if (e.duration_ms) return fmtDuration(e.duration_ms);
  return null;
}

function linkLabel(e: FeedEvent): string {
  if (!e.url) return "";
  if (e.kind.startsWith("preview.")) return "preview";
  if (e.pr && e.url.includes("/pull/")) return `#${e.pr}`;
  if (e.issue && e.url.includes("/issues/")) return `#${e.issue}`;
  if (e.url.includes("/actions/")) return "run";
  return "open";
}

export function EventRow({
  event: e,
  tz,
  selected = false,
  isNew = false,
  showProject = true,
  dense = true,
}: {
  event: FeedEvent;
  tz: string;
  selected?: boolean;
  isNew?: boolean;
  showProject?: boolean;
  dense?: boolean;
}) {
  const info = kindInfo(e.kind);
  const m = metrics(e);
  return (
    <li
      id={`event-${e.id}`}
      data-selected={selected || undefined}
      data-new={isNew || undefined}
      className={cn(
        "feed-row group flex flex-col gap-0.5 rounded-sm px-2 py-1.5 sm:grid sm:items-center sm:gap-x-3 sm:py-0",
        dense ? "sm:min-h-8" : "sm:min-h-9",
        showProject
          ? "sm:grid-cols-[2.75rem_7.5rem_6rem_minmax(0,1fr)_auto]"
          : "sm:grid-cols-[2.75rem_7.5rem_minmax(0,1fr)_auto]",
      )}
    >
      <div className="flex items-center gap-2 sm:contents">
        <time dateTime={e.ts} className="font-mono text-[11px] tabular-nums text-muted-foreground" title={e.ts}>
          {clockIn(e.ts, tz)}
        </time>
        <ActorChip actor={e.actor} className="text-muted-foreground" />
        {showProject &&
          (e.project ? (
            <Link href={`/projects/${e.project}`} className="truncate text-xs text-muted-foreground hover:text-foreground">
              {e.project}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground/60">—</span>
          ))}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:contents">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <KindIcon kind={e.kind} />
          <span className="sr-only">{info.label}: </span>
          <span className="truncate" title={e.summary}>
            {e.summary}
          </span>
          {e.lane && e.kind !== "issue.labeled" && (
            <span className="hidden shrink-0 rounded bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground md:inline">{e.lane}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
          {m && <span className="hidden sm:inline">{m}</span>}
          {e.url && (
            <a
              href={e.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 rounded px-1 text-muted-foreground hover:text-primary"
              aria-label={`Open ${info.label.toLowerCase()} ${linkLabel(e)} in a new tab`}
            >
              <span className="hidden lg:inline">{linkLabel(e)}</span>
              <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      {m && <div className="pl-[1.375rem] font-mono text-[11px] tabular-nums text-muted-foreground sm:hidden">{m}</div>}
    </li>
  );
}
