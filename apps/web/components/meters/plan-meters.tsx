"use client";

import { Gauge, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlanMeter } from "@/lib/types";

/** amber above 70, red above 90. */
export function meterTone(pct: number | null): "ok" | "warn" | "bad" | "unknown" {
  if (pct == null) return "unknown";
  if (pct > 90) return "bad";
  if (pct > 70) return "warn";
  return "ok";
}

const fill: Record<ReturnType<typeof meterTone>, string> = {
  ok: "bg-primary",
  warn: "bg-warn",
  bad: "bg-bad",
  unknown: "bg-transparent",
};

/** "from kyrobook, 4m ago" for a vendor reading, "demo" or "set by RELAY_PLAN_METERS" for the others; "" for none. */
export function meterProvenance(meter: PlanMeter, now: number = Date.now()): string {
  if (meter.source === "vendor") return `from ${meter.worker ?? "a worker"}${meter.capturedAt ? `, ${fmtAgo(meter.capturedAt, now)}` : ""}`;
  if (meter.source === "demo") return "demo";
  if (meter.source === "manual") return "set by RELAY_PLAN_METERS";
  return "";
}

/** The title (hover text): the note when there is no reading; otherwise the value, the reset and where it came from. */
export function meterTitle(meter: PlanMeter, now: number = Date.now()): string {
  if (meter.percentUsed == null) return meter.note ?? `${meter.label}: no reading`;
  const parts = [`${meter.label}: ${meter.percentUsed}% used${meter.resetsIn ? `, resets in ${meter.resetsIn}` : ""}`];
  const from = meterProvenance(meter, now);
  if (from) parts.push(from);
  return parts.join(" · ");
}

/** One meter: label, percentage and bar. Compact (the header) keeps the reset time and the provenance in the title only. */
export function MeterBar({ meter, compact = false }: { meter: PlanMeter; compact?: boolean }) {
  const tone = meterTone(meter.percentUsed);
  const pct = meter.percentUsed ?? 0;
  const none = meter.percentUsed == null;
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1", compact ? "w-[8.5rem]" : "w-full")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={meter.percentUsed ?? undefined}
      aria-valuetext={none ? "no reading" : `${pct}% used`}
      aria-label={`${meter.subscription} ${meter.label}`}
      title={meterTitle(meter)}
      data-source={meter.source}
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
        <span className="truncate text-muted-foreground">{meter.label}</span>
        <span className={cn("font-mono tabular-nums", tone === "warn" && "text-warn", tone === "bad" && "text-bad", none && "text-muted-foreground")}>
          {none ? "no reading" : `${pct}%`}
        </span>
      </div>
      <div className={cn("h-1.5 w-full overflow-hidden rounded-full", tone === "unknown" ? "bg-[repeating-linear-gradient(135deg,var(--border)_0_3px,transparent_3px_6px)]" : "bg-muted")}>
        <div className={cn("h-full rounded-full transition-[width] duration-700", fill[tone])} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {!compact && (
        <div className="text-[11px] text-muted-foreground">
          {none ? meter.note ?? "no meter published" : [meter.resetsIn ? `resets in ${meter.resetsIn}` : null, meterProvenance(meter)].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

/**
 * The meters the header shows: Claude's windows (with or without a reading; the striped bar says "no reading"), plus
 * anything else that carries a number (a manual third meter). Vendors that publish no meter stay on /usage only.
 */
export function headerMeters(meters: PlanMeter[]): PlanMeter[] {
  return meters.filter((m) => m.subscription === "max" || m.percentUsed != null).slice(0, 3);
}

/**
 * Header strip: the plan meters for the metered subscription, refreshed every minute. At lg and up they are compact
 * bars (two by default: 5-hour and weekly; a third only when RELAY_PLAN_METERS supplies one); below that, one pill with
 * the highest percentage in its tone, the windows in a tooltip. Both link to /usage.
 */
export function PlanMeters({ initial }: { initial: PlanMeter[] }) {
  const [meters, setMeters] = useState(initial);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/meters", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { windows: PlanMeter[] };
        if (alive) setMeters(data.windows);
      } catch {
        // keep the last good values
      }
    };
    const id = setInterval(tick, 60_000);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const shown = headerMeters(meters);
  if (shown.length === 0) return null;
  const read = shown.filter((m) => m.percentUsed != null);
  const top = read.length ? read.reduce((a, b) => ((b.percentUsed ?? 0) > (a.percentUsed ?? 0) ? b : a)) : null;
  const topPct = top?.percentUsed ?? 0;
  const tone = meterTone(top?.percentUsed ?? null);
  const Icon = tone === "ok" || tone === "unknown" ? Gauge : TriangleAlert;
  const pillLabel = top ? `Plan meters: ${top.label} at ${topPct}%${tone === "ok" ? "" : tone === "warn" ? ", near the cap" : ", at the cap"}. Open usage` : `Plan meters: no reading yet. Open usage`;
  return (
    <>
      <Link href="/usage" className="hidden items-start gap-4 lg:flex" aria-label="Plan meters, open usage">
        {shown.map((m) => (
          <MeterBar key={m.id} meter={m} compact />
        ))}
      </Link>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/usage"
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs tabular-nums transition-colors hover:bg-accent lg:hidden",
              tone === "warn" && "border-warn/50 text-warn",
              tone === "bad" && "border-bad/50 text-bad",
              tone === "unknown" && "text-muted-foreground",
            )}
            aria-label={pillLabel}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {top ? `${topPct}%` : "—"}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-[11px] tabular-nums">
          <ul className="flex flex-col gap-0.5">
            {shown.map((m) => (
              <li key={m.id} className="flex justify-between gap-4">
                <span>{m.label}</span>
                <span>{m.percentUsed == null ? "no reading" : `${m.percentUsed}%${m.resetsIn ? ` · resets ${m.resetsIn}` : ""}`}</span>
              </li>
            ))}
          </ul>
          {shown.every((m) => m.percentUsed == null) && <p className="mt-1 max-w-[16rem] font-sans text-muted-foreground">{shown[0]?.note}</p>}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
