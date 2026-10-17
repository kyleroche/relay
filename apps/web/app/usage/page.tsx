import type { Metadata } from "next";
import Link from "next/link";
import { MeterBar } from "@/components/meters/plan-meters";
import { PageIntro } from "@/components/page-intro";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AvgContextOverTime, CostByDay } from "@/components/usage/charts";
import { getUsage } from "@/lib/data";
import { fmtCost, fmtInt, fmtTokens } from "@/lib/format";
import { meterSourceLine } from "@/lib/meters";
import { SERIES } from "@/lib/series";
import type { UsageWindow } from "@/lib/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Usage",
  description: "Calls, tokens and cost equivalent per subscription, plan meters, and average input context per call against a baseline.",
  alternates: { canonical: "/usage" },
};

export const dynamic = "force-dynamic";

const WINDOWS: Array<{ id: UsageWindow; label: string }> = [
  { id: "5h", label: "5 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

const DEFAULT_BASELINE = Number(process.env.RELAY_CTX_BASELINE ?? 366_000);

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const windowParam = Array.isArray(sp.window) ? sp.window[0] : sp.window;
  const window: UsageWindow = windowParam === "5h" || windowParam === "30d" ? windowParam : "7d";
  const baselineParam = Number(Array.isArray(sp.baseline) ? sp.baseline[0] : sp.baseline);
  const baseline = Number.isFinite(baselineParam) && baselineParam > 0 ? baselineParam : DEFAULT_BASELINE;

  const [usage, week] = await Promise.all([getUsage(window), getUsage("7d")]);
  const avg = week.avgCtxWindow;
  const delta = baseline ? Math.round(((avg - baseline) / baseline) * 100) : 0;
  const totalCost = usage.subscriptions.reduce((s, r) => s + r.cost_equiv, 0);
  const totalCalls = usage.subscriptions.reduce((s, r) => s + r.calls, 0);
  const days = window === "30d" ? 30 : 7;

  return (
    <>
      <section className="py-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
        <PageIntro doc="/docs/feed">
          Every model call is a <code className="rounded bg-muted px-1 font-mono text-xs">step.usage</code> event with its tokens and a cost equivalent at list price.
        </PageIntro>
        <div className="mt-8">
          <p className="text-xs text-muted-foreground">Average input context per call, last 7 days</p>
          <p className="mt-1 text-5xl font-semibold tracking-tight sm:text-6xl">
            {fmtTokens(avg)}
            <span className="ml-2 text-base font-normal text-muted-foreground">tokens</span>
          </p>
          <p className="mt-2 text-sm">
            <span className={cn("font-mono tabular-nums", delta < 0 ? "text-ok" : "text-warn")}>
              {delta > 0 ? "+" : ""}
              {delta}%
            </span>{" "}
            <span className="text-muted-foreground">
              vs a baseline of {fmtTokens(baseline)} per call
              {" · "}
              <span title="What a coding agent re-reads per call without a harness. Set ?baseline=<tokens> in the URL or RELAY_CTX_BASELINE in the environment.">configurable</span>
            </span>
          </p>
        </div>
      </section>

      <section aria-labelledby="meters" className="mb-10">
        <h2 id="meters" className="text-lg font-semibold tracking-tight">Plan meters</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {usage.windows.map((m) => (
            <div key={m.id} className="rounded-md border bg-card p-3" title="Amber above 70%, red above 90%. Where a vendor publishes no meter, the bar says so instead of guessing.">
              <p className="mb-2 font-mono text-[11px] text-muted-foreground">{m.subscription}</p>
              <MeterBar meter={m} />
            </div>
          ))}
        </div>
        <p className="mt-3 max-w-3xl text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Where these numbers come from.</span> {meterSourceLine(usage.windows)}
        </p>
      </section>

      <section aria-labelledby="by-subscription" className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="by-subscription" className="text-lg font-semibold tracking-tight">By subscription</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {fmtInt(totalCalls)} calls, {fmtCost(totalCost)} cost equivalent in the last {WINDOWS.find((w) => w.id === window)?.label}.
            </p>
          </div>
          <nav aria-label="Window" className="flex rounded-md border p-0.5 text-xs">
            {WINDOWS.map((w) => (
              <Link
                key={w.id}
                href={`/usage?window=${w.id}${baseline !== DEFAULT_BASELINE ? `&baseline=${baseline}` : ""}`}
                aria-current={w.id === window ? "true" : undefined}
                className={cn("rounded px-2.5 py-1", w.id === window ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {w.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-4 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subscription</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cache read</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Avg ctx / call</TableHead>
                <TableHead className="text-right">Cost equiv.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.subscriptions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">No model calls in this window.</TableCell>
                </TableRow>
              )}
              {usage.subscriptions.map((r) => {
                const s = SERIES.find((x) => x.key === r.subscription);
                return (
                  <TableRow key={r.subscription}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block size-2 rounded-sm" style={{ background: s?.color ?? "var(--series-muted)" }} aria-hidden="true" />
                        <span className="font-mono text-xs">{r.subscription}</span>
                        {s && <span className="text-xs text-muted-foreground">{s.label}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtInt(r.calls)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtTokens(r.tokens_in)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtTokens(r.cache_read)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtTokens(r.tokens_out)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtTokens(r.avg_ctx)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{fmtCost(r.cost_equiv)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="cost-by-day">
          <h2 id="cost-by-day" className="text-lg font-semibold tracking-tight">Cost equivalent per day</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">Stacked by subscription, last {days} days.</p>
          <CostByDay daily={usage.daily} days={days} />
        </section>
        <section aria-labelledby="ctx-over-time">
          <h2 id="ctx-over-time" className="text-lg font-semibold tracking-tight">Average context per call</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">Input plus cache-read tokens, averaged per day, against the baseline.</p>
          <AvgContextOverTime series={usage.avgCtx} baseline={baseline} days={days} />
        </section>
      </div>

      <details className="mt-10 rounded-md border p-4 text-sm">
        <summary className="cursor-pointer font-medium">Daily data as a table</summary>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                {SERIES.map((s) => (
                  <TableHead key={s.key} className="text-right">{s.label}</TableHead>
                ))}
                <TableHead className="text-right">Avg ctx</TableHead>
                <TableHead className="text-right">Calls</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.daily.map((d, i) => (
                <TableRow key={d.day}>
                  <TableCell className="font-mono text-xs">{d.day}</TableCell>
                  {SERIES.map((s) => (
                    <TableCell key={s.key} className="text-right font-mono tabular-nums">{fmtCost(d[s.key] ?? 0)}</TableCell>
                  ))}
                  <TableCell className="text-right font-mono tabular-nums">{fmtTokens(usage.avgCtx[i]?.avg_ctx ?? 0)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{usage.avgCtx[i]?.calls ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </>
  );
}
