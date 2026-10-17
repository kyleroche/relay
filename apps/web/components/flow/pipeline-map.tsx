"use client";

/**
 * The flow map: a transit map of what is moving (DESIGN.md, "Visuals"). Lines are lanes, stations are the task
 * stations (lib/flow.ts), projects are origin stops on the left, workers are depots above Running, tasks are pills
 * that travel along their line when their station changes between polls. Motion means activity: particles run only
 * on segments that carry a task, depots breathe only while they hold a claim, and nothing moves on an idle line.
 *
 * Polls /api/flow every 5 s (paused by the toggle or while the tab is hidden) and keeps the previous scene so a pill
 * that changed station slides rather than jumps, a new pill slides in from its project stop, and a merged one
 * leaves at the right edge. Under 640px the map turns vertical: stations become rows, lines run top to bottom.
 * `prefers-reduced-motion` keeps the positions and drops the travel, the particles and the breathing.
 */
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FLOW_LANES, fmtDwell, laneOf, STATIONS, type FlowLane, type FlowSnapshot, type FlowTask, type FlowWorker, type Station } from "@/lib/flow";
import { fmtCost } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Variant = "full" | "strip";
type Orientation = "horizontal" | "vertical";

const POLL_MS = 5_000;
const EXIT_MS = 2_000;
const BREAK_PX = 640;

const LANE_COLOR: Record<FlowLane, string> = {
  claude: "var(--series-1)",
  codex: "var(--series-2)",
  grok: "var(--series-3)",
  cloud: "var(--muted-foreground)",
};
const LANE_LABEL: Record<FlowLane, string> = { claude: "claude", codex: "codex", grok: "grok", cloud: "cloud" };

/* ----------------------------------------------------------------------------------------------- layout */

interface Pt {
  x: number;
  y: number;
}

interface Metrics {
  projectX: number;
  queueX: number;
  mergedX: number;
  laneTop: number;
  laneGap: number;
  depotY: number;
  labelY: number;
  sidingDy: number;
  /** vertical only */
  gutter: number;
  rowTop: number;
  rowGap: number;
}

function metrics(variant: Variant, orientation: Orientation, width: number): Metrics {
  if (orientation === "vertical") {
    return { projectX: 0, queueX: 0, mergedX: 0, laneTop: 0, laneGap: 0, depotY: 28, labelY: 0, sidingDy: 0, gutter: 60, rowTop: 128, rowGap: variant === "strip" ? 44 : 60 };
  }
  if (variant === "strip") return { projectX: 60, queueX: 150, mergedX: width - 52, laneTop: 58, laneGap: 40, depotY: 18, labelY: 36, sidingDy: 42, gutter: 0, rowTop: 0, rowGap: 0 };
  return { projectX: 64, queueX: 196, mergedX: width - 64, laneTop: 132, laneGap: 68, depotY: 46, labelY: 100, sidingDy: 62, gutter: 0, rowTop: 0, rowGap: 0 };
}

interface Layout {
  orientation: Orientation;
  width: number;
  height: number;
  lanes: FlowLane[];
  /** Where a station sits on a lane. */
  at(lane: FlowLane, station: Exclude<Station, "Failed">): Pt;
  /** The failed siding's anchor for a lane. */
  siding(lane: FlowLane): Pt;
  sidingPath: string;
  stationLabel(station: Exclude<Station, "Failed">): Pt;
  linePath(lane: FlowLane): string;
  segmentPath(lane: FlowLane, from: Exclude<Station, "Failed">, to: Exclude<Station, "Failed">): string;
  project(i: number, n: number): Pt;
  branchPath(from: Pt, lane: FlowLane): string;
  depot(i: number, n: number): Pt;
  fan(i: number): Pt;
}

const STATION_INDEX = new Map(STATIONS.map((s, i) => [s, i]));

function makeLayout(variant: Variant, width: number, lanes: FlowLane[], projectCount: number): Layout {
  const orientation: Orientation = width < BREAK_PX ? "vertical" : "horizontal";
  const m = metrics(variant, orientation, width);
  const n = STATIONS.length;
  if (orientation === "horizontal") {
    const laneY = (lane: FlowLane) => m.laneTop + Math.max(0, lanes.indexOf(lane)) * m.laneGap;
    const stationX = (s: Exclude<Station, "Failed">) => m.queueX + ((m.mergedX - m.queueX) * (STATION_INDEX.get(s) ?? 0)) / (n - 1);
    const bottom = m.laneTop + (lanes.length - 1) * m.laneGap;
    const sidingY = bottom + m.sidingDy;
    const runX = stationX("Running");
    const height = sidingY + (variant === "strip" ? 22 : 36);
    return {
      orientation,
      width,
      height,
      lanes,
      at: (lane, s) => ({ x: stationX(s), y: laneY(lane) }),
      siding: () => ({ x: runX + 36, y: sidingY }),
      sidingPath: `M ${runX} ${bottom} C ${runX} ${bottom + m.sidingDy * 0.6} ${runX + 10} ${sidingY} ${runX + 36} ${sidingY} L ${runX + 120} ${sidingY}`,
      stationLabel: (s) => ({ x: stationX(s), y: m.labelY }),
      linePath: (lane) => `M ${m.queueX} ${laneY(lane)} L ${m.mergedX + 28} ${laneY(lane)}`,
      segmentPath: (lane, a, b) => `M ${stationX(a)} ${laneY(lane)} L ${stationX(b)} ${laneY(lane)}`,
      project: (i, count) => {
        const span = Math.max(0, lanes.length - 1) * m.laneGap;
        const y = count <= 1 ? m.laneTop + span / 2 : m.laneTop + (span * i) / (count - 1);
        return { x: m.projectX, y };
      },
      branchPath: (from, lane) => {
        const to = { x: m.queueX, y: laneY(lane) };
        const cx = from.x + (to.x - from.x) * 0.55;
        return `M ${from.x + 8} ${from.y} C ${cx} ${from.y} ${cx} ${to.y} ${to.x} ${to.y}`;
      },
      depot: (i, count) => {
        const gap = Math.min(variant === "strip" ? 96 : 128, (m.mergedX - m.queueX) / Math.max(1, count));
        return { x: runX + (i - (count - 1) / 2) * gap, y: m.depotY };
      },
      fan: (i) => ({ x: 0, y: i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (variant === "strip" ? 16 : 22) }),
    };
  }
  // vertical: lanes are columns, stations are rows
  const laneX = (lane: FlowLane) => m.gutter + ((width - m.gutter - 16) * (Math.max(0, lanes.indexOf(lane)) + 0.5)) / lanes.length;
  const stationY = (s: Exclude<Station, "Failed">) => m.rowTop + (STATION_INDEX.get(s) ?? 0) * m.rowGap;
  const runY = stationY("Running");
  const sidingY = runY + m.rowGap / 2;
  const sidingX = width - 60;
  const height = stationY("Merged") + 44;
  const rightLane = lanes[lanes.length - 1] ?? "claude";
  return {
    orientation,
    width,
    height,
    lanes,
    at: (lane, s) => ({ x: laneX(lane), y: stationY(s) }),
    siding: () => ({ x: sidingX, y: sidingY }),
    sidingPath: `M ${laneX(rightLane)} ${runY} C ${laneX(rightLane)} ${sidingY} ${laneX(rightLane) + 20} ${sidingY} ${sidingX - 16} ${sidingY} L ${width - 12} ${sidingY}`,
    stationLabel: (s) => ({ x: 8, y: stationY(s) }),
    linePath: (lane) => `M ${laneX(lane)} ${m.rowTop} L ${laneX(lane)} ${stationY("Merged") + 24}`,
    segmentPath: (lane, a, b) => `M ${laneX(lane)} ${stationY(a)} L ${laneX(lane)} ${stationY(b)}`,
    project: (i, count) => ({ x: m.gutter + ((width - m.gutter - 16) * (i + 0.5)) / Math.max(1, count), y: 78 }),
    branchPath: (from, lane) => {
      const to = { x: laneX(lane), y: m.rowTop };
      const cy = from.y + (to.y - from.y) * 0.5;
      return `M ${from.x} ${from.y + 8} C ${from.x} ${cy} ${to.x} ${cy} ${to.x} ${to.y}`;
    },
    depot: (i, count) => ({ x: m.gutter + ((width - m.gutter - 16) * (i + 0.5)) / Math.max(1, count), y: m.depotY }),
    fan: (i) => ({ x: 0, y: i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 18 }),
  };
}

/* ----------------------------------------------------------------------------------------------- scene */

type Phase = "enter" | "on" | "exit";

interface Placed {
  task: FlowTask;
  lane: FlowLane;
  pos: Pt;
  phase: Phase;
  /** the last on-line station, for a pill leaving through Merged */
  exitVia: "merged" | "fade";
}

const ON_LINE = new Set<Station>(["Queue", "Claimed", "Running", "PR", "Preview", "Review", "Merged"]);
const parseId = (id: string): { owner: string; repo: string; n: number } | null => {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  return m ? { owner: m[1]!, repo: m[2]!, n: Number(m[3]) } : null;
};
const shortId = (t: FlowTask) => `${t.repo.split("/")[1] ?? t.repo}#${t.issue}`;
const taskHref = (t: FlowTask) => {
  const p = parseId(t.id);
  return p ? `/tasks/${p.owner}/${p.repo}/${p.n}` : "/tasks";
};

/** Which lanes to draw: the three worker lanes always; the dashed cloud line only when a task rides it. */
function lanesFor(snapshot: FlowSnapshot): FlowLane[] {
  const lanes: FlowLane[] = [...FLOW_LANES];
  if (snapshot.tasks.some((t) => laneOf(t.lane) === "cloud")) lanes.push("cloud");
  return lanes;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export interface PipelineMapProps {
  initial?: FlowSnapshot | null;
  variant?: Variant;
  /** The full page shows the toolbar (updated, pause); the strip shows a compact caption row. */
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  className?: string;
}

export function PipelineMap({ initial = null, variant = "full", paused: pausedProp, onPausedChange, className }: PipelineMapProps) {
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(initial);
  const [prev, setPrev] = useState<FlowSnapshot | null>(null);
  const [pausedState, setPausedState] = useState(false);
  const paused = pausedProp ?? pausedState;
  const setPaused = useCallback(
    (v: boolean) => {
      setPausedState(v);
      onPausedChange?.(v);
    },
    [onPausedChange],
  );
  const [now, setNow] = useState(() => Date.now());
  const [width, setWidth] = useState(1200);
  const [stale, setStale] = useState(false);
  const [spawning, setSpawning] = useState<Set<string>>(() => new Set());
  const [exiting, setExiting] = useState<Map<string, Placed>>(() => new Map());
  const [hover, setHover] = useState<string | null>(null);
  /** bumps when `gone` changes, so the placement memo drops the ids that finished leaving */
  const [epoch, setEpoch] = useState(0);
  const gone = useRef(new Set<string>());
  const latest = useRef<FlowSnapshot | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  // width: the layout is in pixels so strokes stay 1.5px at every size. The server renders at 1200; transitions stay
  // off until a frame after the first measurement so the first paint never slides pills from the server's positions.
  const [measured, setMeasured] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    measure();
    const raf = requestAnimationFrame(() => setMeasured(true));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // polling
  useEffect(() => {
    if (paused) return;
    let alive = true;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/flow", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as FlowSnapshot;
        if (!alive) return;
        setPrev(latest.current);
        latest.current = next;
        setSnapshot(next);
        setStale(false);
        setNow(Date.now());
      } catch {
        if (alive) setStale(true);
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [paused]);

  // dwell timers
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const lanes = useMemo(() => (snapshot ? lanesFor(snapshot) : [...FLOW_LANES]), [snapshot]);
  const projects = useMemo(() => snapshot?.projects ?? [], [snapshot]);
  const layout = useMemo(() => makeLayout(variant, width, lanes, projects.length), [variant, width, lanes, projects.length]);

  const projectPos = useCallback((slug: string): Pt => {
    const i = projects.findIndex((p) => p.slug === slug);
    return layout.project(Math.max(0, i), Math.max(1, projects.length));
  }, [projects, layout]);

  // place every drawn task; fan out the ones sharing a stop
  const placed = useMemo(() => {
    const out = new Map<string, Placed>();
    if (!snapshot) return out;
    const groups = new Map<string, number>();
    const sorted = [...snapshot.tasks].sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
    for (const t of sorted) {
      if (gone.current.has(t.id)) continue;
      const lane = laneOf(t.lane);
      const key = `${lane}:${t.station}`;
      const i = groups.get(key) ?? 0;
      groups.set(key, i + 1);
      const fan = layout.fan(i);
      const anchor = t.station === "Failed" ? layout.siding(lane) : layout.at(lane, t.station);
      const pos = t.station === "Failed" && layout.orientation === "horizontal" ? { x: anchor.x + i * 30, y: anchor.y + (i % 2 ? 14 : 0) } : { x: anchor.x + fan.x, y: anchor.y + fan.y };
      const phase: Phase = t.state === "done" ? "exit" : spawning.has(t.id) ? "enter" : "on";
      out.set(t.id, { task: t, lane, pos: phase === "enter" ? projectPos(t.project) : pos, phase, exitVia: "merged" });
    }
    return out;
    // epoch: `gone` is a ref; it bumps when ids finish leaving
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, layout, spawning, projectPos, epoch]);

  // arrivals slide in from their project stop; departures leave through Merged (or fade where they stood)
  useEffect(() => {
    if (!snapshot || !prev) return;
    const before = new Set(prev.tasks.map((t) => t.id));
    const after = new Set(snapshot.tasks.map((t) => t.id));
    const arrived = snapshot.tasks.filter((t) => !before.has(t.id) && t.state !== "done" && !gone.current.has(t.id)).map((t) => t.id);
    const left = prev.tasks.filter((t) => !after.has(t.id) && !gone.current.has(t.id));
    if (left.length) {
      setExiting((cur) => {
        const next = new Map(cur);
        for (const t of left) {
          const lane = laneOf(t.lane);
          const via = t.station === "PR" || t.station === "Preview" || t.station === "Review" || t.station === "Merged" ? "merged" : "fade";
          // pos is resolved against the current layout at render time (see `drawn`), so a resize mid-fade cannot strand the pill
          next.set(t.id, { task: { ...t, state: "done", station: via === "merged" ? "Merged" : t.station }, lane, pos: { x: 0, y: 0 }, phase: "exit", exitVia: via });
        }
        return next;
      });
    }
    if (!arrived.length || reduced) return;
    // two frames: one to paint the pill at its project stop, the next to let the transform transition carry it to its station
    setSpawning((s) => new Set([...s, ...arrived]));
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSpawning((s) => new Set([...s].filter((id) => !arrived.includes(id)))));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [snapshot, prev, reduced]);

  // an exiting pill is removed once it has faded; its id is remembered so a late poll does not resurrect it
  const exitIds = useMemo(() => [...new Set([...exiting.keys(), ...[...placed.values()].filter((p) => p.phase === "exit").map((p) => p.task.id)])].sort().join("|"), [exiting, placed]);
  useEffect(() => {
    if (!exitIds) return;
    const ids = exitIds.split("|");
    const timer = setTimeout(() => {
      for (const id of ids) gone.current.add(id);
      setExiting((cur) => {
        const next = new Map(cur);
        for (const id of ids) next.delete(id);
        return next;
      });
      setEpoch((e) => e + 1);
    }, EXIT_MS + 100);
    return () => clearTimeout(timer);
  }, [exitIds]);

  const drawn = useMemo(() => {
    const leaving = [...exiting.values()]
      .filter((e) => !placed.has(e.task.id))
      .map((e) => ({ ...e, pos: e.exitVia === "merged" ? layout.at(e.lane, "Merged") : e.task.station === "Failed" ? layout.siding(e.lane) : layout.at(e.lane, e.task.station) }));
    return [...placed.values(), ...leaving];
  }, [placed, exiting, layout]);

  // activity: which segments carry a task (particles), how many pills ride each line (thickness)
  const activity = useMemo(() => {
    const segments = new Map<string, { lane: FlowLane; d: string }>();
    const counts = new Map<FlowLane, number>();
    const branches = new Map<string, { lane: FlowLane; d: string }>();
    for (const p of drawn) {
      if (p.phase === "exit" && p.exitVia === "fade") continue;
      const s = p.task.station;
      if (s !== "Failed") counts.set(p.lane, (counts.get(p.lane) ?? 0) + 1);
      const idx = STATION_INDEX.get(s as Exclude<Station, "Failed">);
      if (s === "Queue") {
        const from = projectPos(p.task.project);
        if (projects.some((x) => x.slug === p.task.project)) branches.set(`${p.task.project}:${p.lane}`, { lane: p.lane, d: layout.branchPath(from, p.lane) });
      } else if (idx !== undefined && idx > 0) {
        const a = STATIONS[idx - 1]!;
        const b = STATIONS[idx]!;
        segments.set(`${p.lane}:${a}>${b}`, { lane: p.lane, d: layout.segmentPath(p.lane, a, b) });
      }
      if (s === "Running") segments.set(`${p.lane}:Running>PR`, { lane: p.lane, d: layout.segmentPath(p.lane, "Running", "PR") });
    }
    return { segments, counts, branches };
  }, [drawn, layout, projectPos, projects]);

  const workers = snapshot?.workers ?? [];
  const inMotion = drawn.some((p) => p.phase !== "exit");
  const byId = new Map(drawn.map((p) => [p.task.id, p]));
  const isStrip = variant === "strip";
  const updatedAgo = snapshot ? fmtDwell(snapshot.ts, now) : null;

  return (
    <div className={cn("flow-map relative", className)} data-variant={variant} data-orientation={layout.orientation} data-measured={measured}>
      {!isStrip && (
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="font-mono tabular-nums" aria-live="polite">
            {stale ? "offline: showing the last snapshot" : paused ? "paused" : updatedAgo ? `updated ${updatedAgo} ago` : "loading"}
          </span>
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            aria-pressed={paused}
            className="rounded-md border px-2 py-0.5 font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      )}
      <div ref={ref} className="relative w-full select-none" style={{ height: layout.height }} role="group" aria-label={ariaSummary(snapshot, drawn)}>
        <svg className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          {/* lane lines */}
          {lanes.map((lane) => {
            const count = activity.counts.get(lane) ?? 0;
            return (
              <path
                key={lane}
                d={layout.linePath(lane)}
                className={cn("flow-line", count > 0 && "flow-line--active")}
                style={{ stroke: LANE_COLOR[lane], strokeWidth: 1.5 + Math.min(count, 4) * 0.25, opacity: count > 0 ? 1 : 0.4, strokeDasharray: lane === "cloud" ? "4 5" : undefined }}
                fill="none"
                strokeLinecap="round"
              />
            );
          })}
          {/* station stops on every line */}
          {lanes.map((lane) =>
            STATIONS.map((s) => {
              const p = layout.at(lane, s);
              return <circle key={`${lane}-${s}`} cx={p.x} cy={p.y} r={isStrip ? 2.5 : 3} className="fill-background" style={{ stroke: LANE_COLOR[lane], strokeWidth: 1.5 }} />;
            }),
          )}
          {/* the failed siding */}
          <path d={layout.sidingPath} fill="none" strokeLinecap="round" style={{ stroke: "var(--bad)", strokeWidth: 1.5, opacity: drawn.some((p) => p.task.station === "Failed") ? 0.9 : 0.3, strokeDasharray: "3 4" }} />
          {/* project branches */}
          {inMotion &&
            projects.map((pr, i) => {
              const from = layout.project(i, projects.length);
              const laneSet = new Set(drawn.filter((p) => p.task.project === pr.slug && p.phase !== "exit").map((p) => p.lane));
              return [...laneSet].map((lane) => (
                <path key={`${pr.slug}-${lane}`} d={layout.branchPath(from, lane)} fill="none" strokeLinecap="round" style={{ stroke: LANE_COLOR[lane], strokeWidth: 1.5, opacity: 0.55 }} />
              ));
            })}
          {/* tethers: a depot to the pill it is on */}
          {workers.map((w, i) => {
            const target = w.current ? byId.get(w.current.task_id) : undefined;
            if (!target) return null;
            const d = layout.depot(i, workers.length);
            return (
              <line
                key={`tether-${w.name}`}
                x1={d.x}
                y1={d.y + 10}
                x2={target.pos.x}
                y2={target.pos.y - (layout.orientation === "horizontal" ? 11 : 0)}
                className="flow-tether"
                style={{ stroke: LANE_COLOR[target.lane], strokeWidth: 1, opacity: 0.7, strokeDasharray: "2 4" }}
              />
            );
          })}
          {/* particles: only where something is moving */}
          {!reduced &&
            [...activity.segments.entries(), ...activity.branches.entries()].map(([key, seg]) => (
              <g key={key}>
                {[0, 1].map((k) => (
                  <circle key={k} r={isStrip ? 1.75 : 2} className="flow-particle" style={{ fill: LANE_COLOR[seg.lane], offsetPath: `path("${seg.d}")`, animationDelay: `${k * 1.3}s` }} />
                ))}
              </g>
            ))}
          {/* depots */}
          {workers.map((w, i) => {
            const d = layout.depot(i, workers.length);
            return <Depot key={w.name} w={w} at={d} compact={isStrip} reduced={reduced} />;
          })}
        </svg>

        {/* station labels */}
        {STATIONS.map((s) => {
          const p = layout.stationLabel(s);
          const horizontal = layout.orientation === "horizontal";
          return (
            <span
              key={s}
              className={cn("pointer-events-none absolute text-[11px] text-muted-foreground", horizontal ? "-translate-x-1/2" : "-translate-y-1/2", isStrip && "text-[10px]")}
              style={{ left: p.x, top: p.y }}
            >
              {s}
            </span>
          );
        })}
        {/* project stops */}
        {inMotion &&
          projects.map((pr, i) => {
            const p = layout.project(i, projects.length);
            const horizontal = layout.orientation === "horizontal";
            return (
              <Link
                key={pr.slug}
                href={`/projects/${pr.slug}`}
                className={cn("absolute flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground", horizontal ? "-translate-y-1/2 flex-row-reverse" : "-translate-x-1/2 -translate-y-1/2 flex-col")}
                style={horizontal ? { left: Math.max(0, p.x - 94), top: p.y, width: 100, justifyContent: "flex-start" } : { left: p.x, top: p.y }}
                title={pr.repo}
              >
                <span className="size-3 shrink-0 rounded-full border-[1.5px] border-foreground bg-background" aria-hidden="true" />
                <span className={cn("truncate font-mono", horizontal && "text-right")}>{pr.slug}</span>
              </Link>
            );
          })}
        {/* worker names under the depots */}
        {workers.map((w, i) => {
          const d = layout.depot(i, workers.length);
          // the strip has no row under the depots (the station labels sit there), so its names go beside the node
          const beside = isStrip && layout.orientation === "horizontal";
          return (
            <span
              key={`name-${w.name}`}
              className={cn("pointer-events-none absolute whitespace-nowrap font-mono text-[11px]", beside ? "-translate-y-1/2" : "-translate-x-1/2", w.state === "offline" ? "text-muted-foreground/70" : "text-foreground", isStrip && "text-[10px]")}
              style={beside ? { left: d.x + 11, top: d.y } : { left: d.x, top: d.y + 12 }}
            >
              {w.name}
            </span>
          );
        })}
        {/* empty state */}
        {!inMotion && snapshot && (
          <p className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-center text-[12px] text-muted-foreground" style={{ top: layout.orientation === "horizontal" ? layout.at("codex", "Running").y - 8 : layout.at("codex", "PR").y - 8 }}>
            Nothing in motion. Tasks appear here the moment they are queued.
          </p>
        )}
        {/* pills */}
        {drawn.map((p) => (
          <Pill key={p.task.id} placed={p} now={now} compact={isStrip} hovered={hover === p.task.id} onHover={setHover} vertical={layout.orientation === "vertical"} />
        ))}
      </div>
      <Legend compact={isStrip} />
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- pieces */

function Depot({ w, at, compact, reduced }: { w: FlowWorker; at: Pt; compact: boolean; reduced: boolean }) {
  const r = compact ? 6 : 8;
  const live = w.state === "online" && w.current !== null;
  const stroke = w.state === "offline" ? "var(--muted-foreground)" : "var(--foreground)";
  const title = `${w.name}: ${w.state}${w.current ? `, on ${w.current.task_id}` : ""}, lanes ${w.lanes.join(", ") || "none"}`;
  return (
    <g style={{ opacity: w.state === "offline" ? 0.55 : 1 }}>
      <title>{title}</title>
      {live && !reduced && <circle cx={at.x} cy={at.y} r={r} className="flow-breathe" style={{ stroke, strokeWidth: 1.5, fill: "none" }} />}
      {w.state === "idle" && <circle cx={at.x} cy={at.y} r={r + 3} style={{ stroke, strokeWidth: 1, fill: "none", opacity: 0.35 }} />}
      <circle cx={at.x} cy={at.y} r={r} className="fill-background" style={{ stroke, strokeWidth: 1.5, strokeDasharray: w.state === "offline" ? "2 3" : undefined }} />
      {w.lanes.map((lane, i) => {
        const n = w.lanes.length;
        const dx = (i - (n - 1) / 2) * (compact ? 4 : 5);
        return <circle key={lane} cx={at.x + dx} cy={at.y} r={compact ? 1.4 : 1.75} style={{ fill: LANE_COLOR[laneOf(lane)] }} />;
      })}
    </g>
  );
}

function Pill({ placed, now, compact, hovered, onHover, vertical }: { placed: Placed; now: number; compact: boolean; hovered: boolean; onHover: (id: string | null) => void; vertical: boolean }) {
  const { task: t, lane, pos, phase } = placed;
  const color = LANE_COLOR[lane];
  const failed = t.station === "Failed";
  const worker = t.runner?.replace(/^runner:/, "") ?? null;
  // the strip and the phone layout have no room for the repo name; the hover card and aria-label keep the full id
  const label = compact || vertical ? `#${t.issue}` : shortId(t);
  return (
    <div
      className={cn("flow-pill-wrap absolute left-0 top-0", phase === "exit" && "flow-pill-wrap--exit", phase === "enter" && "opacity-0")}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, zIndex: hovered ? 20 : 10 }}
      data-phase={phase}
      data-station={t.station}
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(t.id)}
      onBlur={() => onHover(null)}
    >
      <div className="-translate-x-1/2 -translate-y-1/2">
        <Link
          href={taskHref(t)}
          className={cn(
            "flow-pill inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border bg-card px-2 font-mono text-[11px] leading-none text-foreground",
            compact && "h-[18px] px-1.5 text-[10px]",
            failed && "opacity-70",
            "focus-visible:outline-2 focus-visible:outline-ring",
          )}
          style={{ borderColor: failed ? "var(--bad)" : color, "--lane": failed ? "var(--bad)" : color } as React.CSSProperties}
          title={t.title}
          aria-label={`${t.id}: ${t.title}, ${t.station}${worker ? ` on ${worker}` : ""}`}
        >
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: failed ? "var(--bad)" : color }} aria-hidden="true" />
          {label}
          {t.preview_state === "failed" && t.station !== "Failed" && (
            <span className="text-[9px] text-bad" title="preview failed">
              !
            </span>
          )}
        </Link>
        {!compact && (
          <span className={cn("pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground", vertical ? "top-[22px]" : "top-[24px]")}>
            {phase === "exit" ? "" : fmtDwell(t.since, now)}
          </span>
        )}
        {hovered && phase !== "exit" && (
          <div
            role="tooltip"
            className={cn("absolute left-1/2 z-30 w-60 -translate-x-1/2 rounded-md border bg-popover p-2.5 text-[11px] leading-4 text-popover-foreground shadow-none", vertical ? "top-[30px]" : "bottom-[30px]")}
          >
            <p className="font-medium text-foreground">{t.title}</p>
            <p className="mt-1 font-mono text-muted-foreground">{t.id}</p>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              <dt>station</dt>
              <dd className={cn("font-mono", failed && "text-bad")}>
                {t.station} <span className="text-muted-foreground/70">({t.state})</span>
              </dd>
              <dt>lane</dt>
              <dd className="font-mono">{t.lane ?? "none"}</dd>
              {worker && (
                <>
                  <dt>worker</dt>
                  <dd className="font-mono">{worker}</dd>
                </>
              )}
              <dt>here for</dt>
              <dd className="font-mono tabular-nums">{fmtDwell(t.since, now)}</dd>
              {t.cost != null && (
                <>
                  <dt>cost</dt>
                  <dd className="font-mono tabular-nums">{fmtCost(t.cost)}</dd>
                </>
              )}
              {t.pr && (
                <>
                  <dt>PR</dt>
                  <dd>
                    <a href={t.pr_url ?? "#"} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                      #{t.pr}
                    </a>
                  </dd>
                </>
              )}
              {t.preview_url && (
                <>
                  <dt>preview</dt>
                  <dd>
                    <a href={t.preview_url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                      {t.preview_state === "ready" ? "open" : t.preview_state}
                    </a>
                  </dd>
                </>
              )}
              {t.error && (
                <>
                  <dt className="text-bad">error</dt>
                  <dd className="break-words text-bad">{t.error}</dd>
                </>
              )}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

function Legend({ compact }: { compact: boolean }) {
  return (
    <div className={cn("mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground", compact && "mt-1 text-[10px]")}>
      {!compact && <span>{STATIONS.join(" · ")} · Failed is the siding under Running</span>}
      <span className="inline-flex items-center gap-2">
        {FLOW_LANES.map((lane) => (
          <span key={lane} className="inline-flex items-center gap-1">
            <span className="inline-block h-[1.5px] w-4 rounded-full" style={{ background: LANE_COLOR[lane] }} aria-hidden="true" />
            <span className="font-mono">{LANE_LABEL[lane]}</span>
          </span>
        ))}
      </span>
      <span>breathing depot: running · still: idle · hollow: offline</span>
      {!compact && <span>particles run only where a task is moving</span>}
    </div>
  );
}

function ariaSummary(snapshot: FlowSnapshot | null, drawn: Placed[]): string {
  if (!snapshot) return "Flow map loading";
  const moving = drawn.filter((p) => p.phase !== "exit" && p.task.station !== "Failed");
  const failed = drawn.filter((p) => p.task.station === "Failed").length;
  const workers = snapshot.workers.filter((w) => w.state !== "offline").length;
  if (!moving.length) return `Flow map: nothing in motion; ${workers} of ${snapshot.workers.length} workers reachable${failed ? `, ${failed} failed` : ""}`;
  return `Flow map: ${moving.length} task${moving.length === 1 ? "" : "s"} in motion across ${snapshot.projects.length} project${snapshot.projects.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}; ${workers} of ${snapshot.workers.length} workers reachable`;
}

/** The compact strip for the top of the feed (about 220px tall). Not mounted anywhere yet. */
export function PipelineStrip({ initial = null, className }: { initial?: FlowSnapshot | null; className?: string }) {
  return <PipelineMap initial={initial} variant="strip" className={className} />;
}
