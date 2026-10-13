"use client";

import { useEffect, useState } from "react";
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

export function MeterBar({ meter, compact = false }: { meter: PlanMeter; compact?: boolean }) {
  const tone = meterTone(meter.percentUsed);
  const pct = meter.percentUsed ?? 0;
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1", compact ? "w-[7.5rem] sm:w-[8.5rem]" : "w-full")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={meter.percentUsed ?? undefined}
      aria-valuetext={meter.percentUsed == null ? "unknown" : `${pct}% used`}
      aria-label={`${meter.subscription} ${meter.label}`}
      title={meter.note ?? (meter.resetsIn ? `${meter.label}: ${pct}% used, resets in ${meter.resetsIn}` : meter.label)}
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
        <span className="truncate text-muted-foreground">{meter.label}</span>
        <span className={cn("font-mono tabular-nums", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>
          {meter.percentUsed == null ? "—" : `${pct}%`}
        </span>
      </div>
      <div className={cn("h-1.5 w-full overflow-hidden rounded-full", tone === "unknown" ? "bg-[repeating-linear-gradient(135deg,var(--border)_0_3px,transparent_3px_6px)]" : "bg-muted")}>
        <div className={cn("h-full rounded-full transition-[width] duration-700", fill[tone])} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {!compact && (
        <div className="text-[11px] text-muted-foreground">
          {meter.resetsIn ? `resets in ${meter.resetsIn}` : meter.note ?? "no meter published"}
        </div>
      )}
      {compact && (
        <div className="hidden text-[10px] leading-none text-muted-foreground sm:block">
          {meter.resetsIn ? `resets ${meter.resetsIn}` : "no meter"}
        </div>
      )}
    </div>
  );
}

/** Header strip: the three plan meters for the metered subscription, refreshed every minute. */
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
  const shown = meters.filter((m) => m.percentUsed != null).slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <div className="flex items-start gap-3 sm:gap-4" aria-label="Plan meters">
      {shown.map((m) => (
        <MeterBar key={m.id} meter={m} compact />
      ))}
    </div>
  );
}
