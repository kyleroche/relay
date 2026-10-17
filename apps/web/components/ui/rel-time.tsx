import { fmtAgo, fmtUntil } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A moment relative to `now`: "3m ago", "yesterday", "in 2h 14m". The ISO instant sits in `title` and `dateTime`.
 * `now` comes from the page so the server and the client render the same text; the row's own text never re-ticks.
 */
export function RelTime({ iso, now, className }: { iso: string; now: number; className?: string }) {
  const future = new Date(iso).getTime() > now;
  return (
    <time dateTime={iso} title={iso} className={cn("font-mono tabular-nums", className)}>
      {future ? `in ${fmtUntil(iso, now)}` : fmtAgo(iso, now)}
    </time>
  );
}
