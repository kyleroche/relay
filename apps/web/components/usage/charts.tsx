"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { fmtCost, fmtTokens } from "@/lib/format";
import { SERIES } from "@/lib/series";
import type { UsageSummary } from "@/lib/types";

const axisTick = { fill: "var(--muted-foreground)", fontSize: 11, fontFamily: "var(--font-geist-mono)" };

function dayTick(day: string) {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function dayLong(day: string) {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function TipFrame({ title, rows }: { title: string; rows: Array<{ color?: string; label: string; value: string }> }) {
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              {r.color && <span className="inline-block size-2 rounded-sm" style={{ background: r.color }} aria-hidden="true" />}
              {r.label}
            </span>
            <span className="font-mono tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CostTip(props: Partial<TooltipContentProps<number, string>>) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  const rows: Array<{ color?: string; label: string; value: string }> = SERIES.filter((s) => payload.some((p) => p.dataKey === s.key)).map((s) => ({
    color: s.color,
    label: s.label,
    value: fmtCost(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0)),
  }));
  const total = payload.reduce((sum, p) => sum + Number(p.value ?? 0), 0);
  rows.push({ label: "Total", value: fmtCost(total) });
  return <TipFrame title={dayLong(String(label))} rows={rows} />;
}

export function CostByDay({ daily, days = 7 }: { daily: UsageSummary["daily"]; days?: number }) {
  const data = daily.slice(-days).map((d) => ({ ...d, max: d.max ?? 0, codex: d.codex ?? 0, grok: d.grok ?? 0 }));
  return (
    <figure>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="35%">
            <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
            <XAxis dataKey="day" tickFormatter={days > 7 ? (d: string) => d.slice(5) : dayTick} tick={axisTick} axisLine={false} tickLine={false} interval={days > 7 ? 4 : 0} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => `$${v}`} />
            <Tooltip content={<CostTip />} cursor={{ fill: "var(--accent)" }} />
            <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }} />
            {SERIES.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="cost"
                fill={s.color}
                stroke="var(--background)"
                strokeWidth={1}
                maxBarSize={24}
                radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Stacked bars of cost equivalent per day by subscription.</figcaption>
    </figure>
  );
}

function CtxTip(props: Partial<TooltipContentProps<number, string>>) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as { avg_ctx: number; calls: number } | undefined;
  return (
    <TipFrame
      title={dayLong(String(label))}
      rows={[
        { color: "var(--series-1)", label: "Avg context / call", value: `${fmtTokens(point?.avg_ctx ?? 0)} tokens` },
        { label: "Calls", value: String(point?.calls ?? 0) },
      ]}
    />
  );
}

export function AvgContextOverTime({ series, baseline, days = 7 }: { series: UsageSummary["avgCtx"]; baseline: number; days?: number }) {
  const data = series.slice(-days);
  const top = Math.max(baseline, ...data.map((d) => d.avg_ctx)) * 1.1;
  return (
    <figure>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
            <XAxis dataKey="day" tickFormatter={days > 7 ? (d: string) => d.slice(5) : dayTick} tick={axisTick} axisLine={false} tickLine={false} interval={days > 7 ? 4 : 0} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} domain={[0, top]} tickFormatter={(v: number) => fmtTokens(v)} />
            <Tooltip content={<CtxTip />} cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }} />
            <ReferenceLine
              y={baseline}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              label={{ value: `baseline ${fmtTokens(baseline)}`, position: "insideTopRight", fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Line
              type="monotone"
              dataKey="avg_ctx"
              name="Avg context per call"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={{ r: 4, fill: "var(--series-1)", stroke: "var(--background)", strokeWidth: 2 }}
              activeDot={{ r: 5, stroke: "var(--background)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Average input context per model call by day, against the baseline.</figcaption>
    </figure>
  );
}
