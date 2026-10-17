"use client";

/**
 * The flow map: a transit map of what is moving (DESIGN.md, "Visuals"). Rails are lanes, stations are the task
 * stations (lib/flow.ts), projects are origin nodes on the left, workers are machines above Running, tasks are
 * trains (filled pills) that travel along their rail when their station changes between polls. Motion means
 * activity: particles stream only on segments that carry a task, a machine's heartbeat runs only while it holds a
 * claim, an idle rail breathes faintly and nothing on it moves.
 *
 * Three layers: a canvas (flow-canvas.tsx: the drifting dot grid and the particle streams), an SVG (rail glows,
 * rails, stations, branches, tethers, the siding) and HTML (labels, project nodes, machines, trains, the hover
 * card). Geometry lives in layout.ts.
 *
 * Polls /api/flow every 5 s (paused by the toggle or while the tab is hidden) and keeps the previous scene so a train
 * that changed station slides rather than jumps, a new one slides in from its project node, and a merged one
 * dissolves into the Merged cap. Under 640px the map turns vertical: stations become rows, rails run top to bottom.
 * `prefers-reduced-motion` keeps the positions and drops the travel, the particles, the pulses and the heartbeat.
 */
import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FLOW_LANES, fmtDwell, laneOf, STATIONS, type FlowLane, type FlowSnapshot, type FlowTask, type FlowWorker, type Station } from "@/lib/flow";
import { fmtCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FlowGrid, FlowParticles, type Track } from "./flow-canvas";
import { cubicPath, linePath, makeLayout, sampleCubic, STATION_INDEX, type Cubic, type Layout, type OnLine, type Pt, type Variant } from "./layout";

export type { Variant } from "./layout";

const POLL_MS = 5_000;
const EXIT_MS = 2_000;
const TRAVEL_MS = 1_100;
/** At most this many trains per station per lane; the rest fold into one "+N" chip. */
const MAX_PER_STOP = 5;
/** At most this many project origins; the rest fold into one "+N projects" stop. */
const MAX_PROJECTS = 6;
const OVERFLOW_SLUG = "\u0000more";

const LANE_VAR: Record<FlowLane, string> = {
  claude: "--series-1",
  codex: "--series-2",
  grok: "--series-3",
  cloud: "--muted-foreground",
};
const LANE_LABEL: Record<FlowLane, string> = { claude: "claude", codex: "codex", grok: "grok", cloud: "cloud" };
const FALLBACK: Record<FlowLane, string> = { claude: "#3987e5", codex: "#d95926", grok: "#199e70", cloud: "#8a8f9c" };

/** How long a task may reasonably sit at a station before its dwell ring fills and turns amber. */
const BUDGET_MS: Record<Station, number> = {
  Queue: 10 * 60_000,
  Claimed: 3 * 60_000,
  Running: 30 * 60_000,
  PR: 10 * 60_000,
  Preview: 15 * 60_000,
  Review: 60 * 60_000,
  Merged: 60_000,
  Failed: 60 * 60_000,
};

/* ----------------------------------------------------------------------------------------------- scene */

type Phase = "enter" | "on" | "exit";

interface Placed {
  task: FlowTask;
  lane: FlowLane;
  pos: Pt;
  phase: Phase;
  /** the last on-line station, for a train leaving through Merged */
  exitVia: "merged" | "fade";
}

const parseId = (id: string): { owner: string; repo: string; n: number } | null => {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  return m ? { owner: m[1]!, repo: m[2]!, n: Number(m[3]) } : null;
};
const repoName = (t: FlowTask) => t.repo.split("/")[1] ?? t.repo;
const taskHref = (t: FlowTask) => {
  const p = parseId(t.id);
  return p ? `/tasks/${p.owner}/${p.repo}/${p.n}` : "/tasks";
};

/** The snapshot narrowed to the chosen projects (an empty or missing filter keeps everything). */
function narrow(snapshot: FlowSnapshot | null, projects: string[] | undefined): FlowSnapshot | null {
  if (!snapshot || !projects?.length) return snapshot;
  const keep = new Set(projects);
  return { ...snapshot, projects: snapshot.projects.filter((p) => keep.has(p.slug)), tasks: snapshot.tasks.filter((t) => keep.has(t.project)) };
}

/** Which lanes to draw: the three worker lanes always; the dashed cloud rail only when a task rides it. */
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

/** The lane colours as the canvas needs them: resolved strings, re-read when the theme class flips. */
function useLaneColors(ref: React.RefObject<HTMLElement | null>): Record<FlowLane, string> {
  const [colors, setColors] = useState<Record<FlowLane, string>>(FALLBACK);
  useEffect(() => {
    const read = () => {
      const el = ref.current;
      if (!el) return;
      const cs = getComputedStyle(el);
      const next = { ...FALLBACK };
      for (const lane of Object.keys(LANE_VAR) as FlowLane[]) {
        const v = cs.getPropertyValue(LANE_VAR[lane]).trim();
        if (v) next[lane] = v;
      }
      setColors((cur) => (FLOW_LANES.every((l) => cur[l] === next[l]) && cur.cloud === next.cloud ? cur : next));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [ref]);
  return colors;
}

export interface PipelineMapProps {
  initial?: FlowSnapshot | null;
  variant?: Variant;
  /** The full page shows the toolbar (updated, pause); the strip shows nothing around the panel. */
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  /** Project slugs to draw; empty or missing draws every project. */
  projects?: string[];
  /** Every snapshot the map receives (the initial one and each poll), for a filter row built from its projects. */
  onSnapshot?: (snapshot: FlowSnapshot) => void;
  className?: string;
}

export function PipelineMap({ initial = null, variant = "full", paused: pausedProp, onPausedChange, projects: projectFilter, onSnapshot, className }: PipelineMapProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [raw, setRaw] = useState<FlowSnapshot | null>(initial);
  const [rawPrev, setRawPrev] = useState<FlowSnapshot | null>(null);
  const filterKey = (projectFilter ?? []).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(() => narrow(raw, projectFilter), [raw, filterKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prev = useMemo(() => narrow(rawPrev, projectFilter), [rawPrev, filterKey]);
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  useEffect(() => {
    if (initial) onSnapshotRef.current?.(initial);
  }, [initial]);
  const [pausedState, setPausedState] = useState(false);
  const paused = pausedProp ?? pausedState;
  const setPaused = useCallback(
    (v: boolean) => {
      setPausedState(v);
      onPausedChange?.(v);
    },
    [onPausedChange],
  );
  // seeded from the snapshot so the server and the first client render agree ("updated 0s ago", the same ring fractions)
  const [now, setNow] = useState(() => (initial ? new Date(initial.ts).getTime() : 0));
  const [width, setWidth] = useState(1200);
  const [stale, setStale] = useState(false);
  const [spawning, setSpawning] = useState<Set<string>>(() => new Set());
  const [exiting, setExiting] = useState<Map<string, Placed>>(() => new Map());
  const [travel, setTravel] = useState<Map<string, "fwd" | "back">>(() => new Map());
  const [hover, setHover] = useState<string | null>(null);
  /** bumps when `gone` changes, so the placement memo drops the ids that finished leaving */
  const [epoch, setEpoch] = useState(0);
  const gone = useRef(new Set<string>());
  const latest = useRef<FlowSnapshot | null>(initial);
  const lastPos = useRef(new Map<string, Pt>());
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const colors = useLaneColors(ref);

  // width: the layout is in pixels so strokes stay crisp at every size. The server renders at 1200; transitions stay
  // off until a frame after the first measurement so the first paint never slides trains from the server's positions.
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
        setRawPrev(latest.current);
        latest.current = next;
        setRaw(next);
        setStale(false);
        setNow(Date.now());
        onSnapshotRef.current?.(next);
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

  // dwell rings
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const lanes = useMemo(() => (snapshot ? lanesFor(snapshot) : [...FLOW_LANES]), [snapshot]);
  const allProjects = useMemo(() => snapshot?.projects ?? [], [snapshot]);
  // the origin stops: the first MAX_PROJECTS, then one "+N projects" stop that the rest spawn from
  const projects = useMemo(() => {
    if (allProjects.length <= MAX_PROJECTS) return allProjects;
    const more = allProjects.length - MAX_PROJECTS;
    return [...allProjects.slice(0, MAX_PROJECTS), { slug: OVERFLOW_SLUG, repo: `${more} more project${more === 1 ? "" : "s"}` }];
  }, [allProjects]);
  const workerCount = snapshot?.workers.length ?? 0;
  // the deepest pile at one stop decides how far apart the rails sit
  const stack = useMemo(() => {
    const counts = new Map<string, number>();
    let max = 1;
    for (const t of snapshot?.tasks ?? []) {
      if (t.state === "done") continue;
      const key = `${laneOf(t.lane)}:${t.station}`;
      const n = Math.min(MAX_PER_STOP + 1, (counts.get(key) ?? 0) + 1);
      counts.set(key, n);
      if (n > max) max = n;
    }
    return max;
  }, [snapshot]);
  const layout = useMemo(() => makeLayout(variant, width, lanes, workerCount, stack), [variant, width, lanes, workerCount, stack]);
  const horizontal = layout.orientation === "horizontal";
  const isStrip = variant === "strip";
  const compact = isStrip || !horizontal;

  const projectPos = useCallback(
    (slug: string): Pt => {
      let i = projects.findIndex((p) => p.slug === slug);
      if (i < 0 && allProjects.some((p) => p.slug === slug)) i = projects.length - 1; // folded into the "+N projects" stop
      return layout.project(Math.max(0, i), Math.max(1, projects.length));
    },
    [projects, allProjects, layout],
  );

  // place every drawn task; fan out the ones sharing a stop, fold the ones past MAX_PER_STOP into an overflow count
  const { placed, overflow } = useMemo(() => {
    const out = new Map<string, Placed>();
    const overflow = new Map<string, { lane: FlowLane; station: Station; n: number }>();
    if (!snapshot) return { placed: out, overflow };
    const groups = new Map<string, number>();
    const sorted = [...snapshot.tasks].sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
    for (const t of sorted) {
      if (gone.current.has(t.id)) continue;
      const lane = laneOf(t.lane);
      const key = `${lane}:${t.station}`;
      const i = groups.get(key) ?? 0;
      groups.set(key, i + 1);
      if (i >= MAX_PER_STOP) {
        const cur = overflow.get(key);
        overflow.set(key, { lane, station: t.station, n: (cur?.n ?? 0) + 1 });
        continue;
      }
      const fan = layout.fan(i);
      const anchor = t.station === "Failed" ? layout.siding(lane) : layout.at(lane, t.station);
      const pos = t.station === "Failed" && horizontal ? { x: anchor.x + i * 34, y: anchor.y + (i % 2 ? 16 : 0) } : { x: anchor.x + fan.x, y: anchor.y + fan.y };
      const phase: Phase = t.state === "done" ? "exit" : spawning.has(t.id) ? "enter" : "on";
      out.set(t.id, { task: t, lane, pos: phase === "enter" ? projectPos(t.project) : pos, phase, exitVia: "merged" });
    }
    return { placed: out, overflow };
    // epoch: `gone` is a ref; it bumps when ids finish leaving
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, layout, spawning, projectPos, epoch, horizontal]);

  // arrivals slide in from their project node; departures leave through Merged (or fade where they stood)
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
          // pos is resolved against the current layout at render time (see `drawn`), so a resize mid-fade cannot strand the train
          next.set(t.id, { task: { ...t, state: "done", station: via === "merged" ? "Merged" : t.station }, lane, pos: { x: 0, y: 0 }, phase: "exit", exitVia: via });
        }
        return next;
      });
    }
    if (!arrived.length || reduced) return;
    // two frames: one to paint the train at its project node, the next to let the transform transition carry it to its station
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

  // an exiting train is removed once it has dissolved; its id is remembered so a late poll does not resurrect it
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

  // travel: a train whose position changed between renders gets a comet tail for a moment, pointing back along its path
  useLayoutEffect(() => {
    const moved = new Map<string, "fwd" | "back">();
    const next = new Map<string, Pt>();
    for (const p of drawn) {
      next.set(p.task.id, p.pos);
      const was = lastPos.current.get(p.task.id);
      if (!was || p.phase === "enter") continue;
      const dx = p.pos.x - was.x;
      const dy = p.pos.y - was.y;
      if (Math.hypot(dx, dy) < 4) continue;
      const delta = horizontal ? dx : dy;
      moved.set(p.task.id, delta >= 0 ? "fwd" : "back");
    }
    lastPos.current = next;
    if (!moved.size || reduced || !measured) return;
    setTravel((cur) => new Map([...cur, ...moved]));
    const timer = setTimeout(() => {
      setTravel((cur) => {
        const out = new Map(cur);
        for (const id of moved.keys()) out.delete(id);
        return out;
      });
    }, TRAVEL_MS);
    return () => clearTimeout(timer);
  }, [drawn, horizontal, reduced, measured]);

  // a resize moves every train at once; that is not travel
  const widthRef = useRef(width);
  useLayoutEffect(() => {
    if (widthRef.current !== width) {
      widthRef.current = width;
      setTravel(new Map());
    }
  }, [width]);

  const workers = snapshot?.workers ?? [];
  const byId = useMemo(() => new Map(drawn.map((p) => [p.task.id, p])), [drawn]);

  // activity: which segments carry a train (particles, pulse), how many ride each rail, where the branches and tethers run
  const activity = useMemo(() => {
    const segments = new Map<string, { lane: FlowLane; a: Pt; b: Pt }>();
    const counts = new Map<FlowLane, number>();
    const branches = new Map<string, { lane: FlowLane; c: Cubic }>();
    const occupied = new Set<string>();
    const mergingLanes = new Set<FlowLane>();
    for (const p of drawn) {
      if (p.phase === "exit") {
        if (p.exitVia === "merged") mergingLanes.add(p.lane);
        continue;
      }
      const s = p.task.station;
      occupied.add(`${p.lane}:${s}`);
      if (s !== "Failed") counts.set(p.lane, (counts.get(p.lane) ?? 0) + 1);
      const idx = STATION_INDEX.get(s);
      if (s === "Queue") {
        const origin = projects.some((x) => x.slug === p.task.project) ? p.task.project : allProjects.some((x) => x.slug === p.task.project) ? OVERFLOW_SLUG : null;
        if (origin) branches.set(`${origin}:${p.lane}`, { lane: p.lane, c: layout.branch(projectPos(origin), p.lane) });
      } else if (idx !== undefined && idx > 0) {
        const a = STATIONS[idx - 1]!;
        const b = STATIONS[idx]!;
        const [pa, pb] = layout.segment(p.lane, a, b);
        segments.set(`${p.lane}:${a}>${b}`, { lane: p.lane, a: pa, b: pb });
      }
      if (s === "Running") {
        const [pa, pb] = layout.segment(p.lane, "Running", "PR");
        segments.set(`${p.lane}:Running>PR`, { lane: p.lane, a: pa, b: pb });
      }
    }
    const tethers = new Map<string, { lane: FlowLane; c: Cubic; from: Pt }>();
    workers.forEach((w, i) => {
      const target = w.current ? byId.get(w.current.task_id) : undefined;
      if (!target || target.phase === "exit") return;
      const mc = layout.machine(i, workers.length);
      tethers.set(w.name, { lane: target.lane, c: layout.tether(mc, target.pos), from: mc });
    });
    return { segments, counts, branches, occupied, tethers, mergingLanes };
  }, [drawn, layout, projectPos, projects, allProjects, workers, byId]);

  const tracks = useMemo<Track[]>(() => {
    const out: Track[] = [];
    for (const [key, seg] of activity.segments) {
      out.push({ key, color: colors[seg.lane], kind: "rail", pts: [seg.a, seg.b], density: Math.min(1, (activity.counts.get(seg.lane) ?? 1) / 3) });
    }
    for (const [key, br] of activity.branches) out.push({ key: `branch:${key}`, color: colors[br.lane], kind: "branch", pts: sampleCubic(br.c), density: 0.5 });
    for (const [key, te] of activity.tethers) out.push({ key: `tether:${key}`, color: colors[te.lane], kind: "tether", pts: sampleCubic(te.c), density: 0.8 });
    return out;
  }, [activity, colors]);

  const inMotion = drawn.some((p) => p.phase !== "exit");
  const updatedAgo = snapshot ? fmtDwell(snapshot.ts, now) : null;
  const anyFailed = drawn.some((p) => p.task.station === "Failed" && p.phase !== "exit");
  const railWidth = isStrip ? 5 : 7;
  const machineOn = (w: FlowWorker) => (w.current ? byId.get(w.current.task_id)?.lane : undefined);

  const showRepo = horizontal && layout.stationSpacing >= 134;

  return (
    <div className={cn("flow-map relative", className)} data-variant={variant} data-orientation={layout.orientation} data-measured={measured}>
      <div ref={ref} className={cn("flow-panel relative w-full select-none", isStrip && "flow-panel--strip")} style={{ height: layout.height }} role="group" aria-label={ariaSummary(snapshot, drawn)}>
        <FlowGrid width={layout.width} height={layout.height} reduced={reduced} running={!paused} message={!inMotion && snapshot ? "Nothing in motion" : null} />
        <div className="flow-vignette" aria-hidden="true" />
        {!isStrip && (
          <div className="flow-toolbar">
            <span className="font-mono tabular-nums" aria-live="polite">
              {stale ? "offline: showing the last snapshot" : paused ? "paused" : updatedAgo ? `updated ${updatedAgo} ago` : "loading"}
            </span>
            <button type="button" onClick={() => setPaused(!paused)} aria-pressed={paused} className="flow-toolbar-button focus-visible:outline-2 focus-visible:outline-ring">
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        )}

        <svg className="flow-svg absolute inset-0 overflow-visible" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          <defs>
            <filter id={`${uid}-glow`} filterUnits="userSpaceOnUse" x={-40} y={-40} width={layout.width + 80} height={layout.height + 80}>
              <feGaussianBlur stdDeviation={isStrip ? 4 : 6} />
            </filter>
            <filter id={`${uid}-soft`} filterUnits="userSpaceOnUse" x={-40} y={-40} width={layout.width + 80} height={layout.height + 80}>
              <feGaussianBlur stdDeviation={2.2} />
            </filter>
            {lanes.map((lane) => {
              const [a, b] = layout.rail(lane);
              return (
                <linearGradient key={lane} id={`${uid}-rail-${lane}`} gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                  <stop offset="0" stopColor={colors[lane]} stopOpacity={0.4} />
                  <stop offset="0.55" stopColor={colors[lane]} stopOpacity={0.85} />
                  <stop offset="1" stopColor={colors[lane]} stopOpacity={1} />
                </linearGradient>
              );
            })}
            {lanes.map((lane) => (
              <radialGradient key={lane} id={`${uid}-halo-${lane}`}>
                <stop offset="0" stopColor={colors[lane]} stopOpacity={0.6} />
                <stop offset="0.45" stopColor={colors[lane]} stopOpacity={0.2} />
                <stop offset="1" stopColor={colors[lane]} stopOpacity={0} />
              </radialGradient>
            ))}
          </defs>

          {/* rails: glow, body, top highlight, travelling pulse */}
          {lanes.map((lane) => {
            const [a, b] = layout.rail(lane);
            const active = (activity.counts.get(lane) ?? 0) > 0;
            const d = linePath(a, b);
            const hl = horizontal ? linePath({ x: a.x + 6, y: a.y - railWidth / 2 + 1 }, { x: b.x - 6, y: b.y - railWidth / 2 + 1 }) : linePath({ x: a.x - railWidth / 2 + 1, y: a.y + 6 }, { x: b.x - railWidth / 2 + 1, y: b.y - 6 });
            return (
              <g key={lane} className={cn("flow-rail", active ? "flow-rail--active" : "flow-rail--idle")} style={{ color: colors[lane] }}>
                <path d={d} className="flow-rail-glow" stroke={colors[lane]} strokeWidth={railWidth * 2.6} strokeLinecap="round" fill="none" filter={`url(#${uid}-glow)`} />
                <path d={d} stroke={`url(#${uid}-rail-${lane})`} strokeWidth={railWidth} strokeLinecap="round" fill="none" strokeDasharray={lane === "cloud" ? `${railWidth * 2} ${railWidth * 1.6}` : undefined} />
                {lane !== "cloud" && <path d={hl} className="flow-rail-highlight" strokeWidth={1} strokeLinecap="round" fill="none" />}
                {active && !reduced && lane !== "cloud" && (
                  <g filter={`url(#${uid}-soft)`}>
                    <path d={d} pathLength={1} className="flow-rail-pulse flow-rail-pulse--halo" stroke={colors[lane]} strokeWidth={railWidth * 2.2} strokeLinecap="round" fill="none" strokeDasharray="0.12 1" />
                    <path d={d} pathLength={1} className="flow-rail-pulse" stroke={colors[lane]} strokeWidth={railWidth - 1} strokeLinecap="round" fill="none" strokeDasharray="0.12 1" />
                  </g>
                )}
              </g>
            );
          })}

          {/* the failed siding */}
          <g className={cn("flow-siding", anyFailed && "flow-siding--active")}>
            <path d={cubicPath(layout.sidingCurve)} fill="none" strokeLinecap="round" strokeWidth={isStrip ? 2.5 : 3} strokeDasharray="5 7" />
            <path d={linePath(layout.sidingTail[0], layout.sidingTail[1])} fill="none" strokeLinecap="round" strokeWidth={isStrip ? 2.5 : 3} strokeDasharray="5 7" />
          </g>

          {/* project branches into Queue */}
          {inMotion &&
            projects.map((pr, i) => {
              const from = layout.project(i, projects.length);
              const laneSet = new Set(drawn.filter((p) => p.task.project === pr.slug && p.phase !== "exit").map((p) => p.lane));
              return [...laneSet].map((lane) => (
                <path key={`${pr.slug}-${lane}`} d={cubicPath(layout.branch(from, lane))} className="flow-branch" fill="none" strokeLinecap="round" stroke={colors[lane]} strokeWidth={isStrip ? 2 : 2.5} />
              ));
            })}

          {/* tethers: a machine to the train it is on */}
          {[...activity.tethers.entries()].map(([name, te]) => (
            <path key={`tether-${name}`} d={cubicPath(te.c)} className="flow-tether" fill="none" strokeLinecap="round" stroke={colors[te.lane]} strokeWidth={2} />
          ))}

          {/* stations on every rail; Merged is the bright cap */}
          {lanes.map((lane) =>
            STATIONS.map((s) => {
              const p = layout.at(lane, s);
              const busy = activity.occupied.has(`${lane}:${s}`);
              const merged = s === "Merged";
              const r = isStrip ? 4.5 : 5.5;
              return (
                <g key={`${lane}-${s}`} className={cn("flow-station", busy && "flow-station--busy", merged && "flow-station--cap", merged && activity.mergingLanes.has(lane) && "flow-station--flash")}>
                  {(busy || merged) && <circle cx={p.x} cy={p.y} r={merged ? (isStrip ? 16 : 22) : isStrip ? 14 : 18} fill={`url(#${uid}-halo-${lane})`} className="flow-station-halo" />}
                  {merged ? (
                    <>
                      <circle cx={p.x} cy={p.y} r={r + 1.5} fill={colors[lane]} />
                      <circle cx={p.x} cy={p.y} r={isStrip ? 2 : 2.5} className="flow-station-core-bright" />
                    </>
                  ) : (
                    <circle cx={p.x} cy={p.y} r={r} className="flow-station-core" stroke={colors[lane]} strokeWidth={isStrip ? 2 : 2.5} />
                  )}
                </g>
              );
            }),
          )}
        </svg>
        <FlowParticles tracks={tracks} width={layout.width} height={layout.height} reduced={reduced} running={!paused} />

        {/* station names */}
        {STATIONS.map((s) => {
          const p = layout.stationLabel(s);
          return (
            <span key={s} className={cn("flow-station-label", horizontal ? "-translate-x-1/2" : "-translate-y-1/2")} style={{ left: p.x, top: p.y }}>
              {s}
            </span>
          );
        })}
        <span className={cn("flow-station-label flow-station-label--failed", horizontal ? "-translate-y-1/2" : "-translate-x-full")} style={{ left: layout.sidingLabel.x, top: layout.sidingLabel.y }}>
          Failed
        </span>

        {/* project origin nodes; the last one may be the "+N projects" stop */}
        {inMotion &&
          projects.map((pr, i) => {
            const p = layout.project(i, projects.length);
            const more = pr.slug === OVERFLOW_SLUG;
            return (
              <Link
                key={pr.slug}
                href={more ? "/projects" : `/projects/${pr.slug}`}
                className={cn("flow-origin absolute flex items-center gap-2", horizontal ? "-translate-y-1/2 flex-row-reverse" : "-translate-x-1/2 -translate-y-1/2 flex-col gap-1", more && "flow-origin--more")}
                style={horizontal ? { left: Math.max(0, p.x - (isStrip ? 92 : 136)), top: p.y, width: isStrip ? 100 : 144, justifyContent: "flex-start" } : { left: p.x, top: p.y }}
                title={pr.repo}
              >
                <span className="flow-origin-node" aria-hidden="true" />
                <span className={cn("flow-origin-name truncate", horizontal && "text-right")}>{more ? `+${allProjects.length - MAX_PROJECTS} projects` : pr.slug}</span>
              </Link>
            );
          })}

        {/* overflow chips: the trains past MAX_PER_STOP at a stop */}
        {[...overflow.values()].map((o) => {
          const anchor = o.station === "Failed" ? layout.siding(o.lane) : layout.at(o.lane, o.station);
          const fan = layout.fan(MAX_PER_STOP);
          const pos = o.station === "Failed" && horizontal ? { x: anchor.x + MAX_PER_STOP * 34, y: anchor.y + 16 } : { x: anchor.x + fan.x, y: anchor.y + fan.y };
          return (
            <Link
              key={`more-${o.lane}-${o.station}`}
              href="/tasks"
              className="flow-more absolute -translate-x-1/2 -translate-y-1/2 focus-visible:outline-2 focus-visible:outline-ring"
              style={{ left: pos.x, top: pos.y, "--lane": o.station === "Failed" ? "var(--bad)" : colors[o.lane] } as React.CSSProperties}
              title={`${o.n} more ${o.lane} task${o.n === 1 ? "" : "s"} at ${o.station}`}
              aria-label={`${o.n} more ${o.lane} task${o.n === 1 ? "" : "s"} at ${o.station}, open the task list`}
            >
              +{o.n}
            </Link>
          );
        })}

        {/* machines above Running */}
        {workers.map((w, i) => (
          <Machine key={w.name} w={w} at={layout.machine(i, workers.length)} size={layout.machineSize} compact={compact} reduced={reduced} colors={colors} onLane={machineOn(w)} />
        ))}

        {/* trains */}
        {drawn.map((p) => (
          <Train
            key={p.task.id}
            placed={p}
            now={now}
            compact={compact}
            wide={showRepo}
            hovered={hover === p.task.id}
            onHover={setHover}
            vertical={!horizontal}
            travel={travel.get(p.task.id) ?? null}
            color={colors[p.lane]}
            reduced={reduced}
          />
        ))}
      </div>
      {!isStrip && <Legend />}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- pieces */

const EKG_D = "M0 7 H14 L18 7 L21 1.5 L24 12.5 L27 7 H40 L43 4 L46 10 L49 7 H64";
const EKG_FLAT = "M0 7 H64";

function Machine({ w, at, size, compact, reduced, colors, onLane }: { w: FlowWorker; at: Pt; size: { w: number; h: number }; compact: boolean; reduced: boolean; colors: Record<FlowLane, string>; onLane: FlowLane | undefined }) {
  const running = w.state === "online" && w.current !== null;
  const offline = w.state === "offline";
  const tone = onLane ? colors[onLane] : w.lanes[0] ? colors[laneOf(w.lanes[0])] : "currentColor";
  const title = `${w.name}: ${w.state}${w.current ? `, on ${w.current.task_id}` : ""}, lanes ${w.lanes.join(", ") || "none"}`;
  const dots = (
    <span className="flex items-center gap-[3px]" aria-hidden="true">
      {w.lanes.map((lane) => (
        <span key={lane} className="flow-machine-dot" style={{ background: colors[laneOf(lane)] }} />
      ))}
    </span>
  );
  const ekg = (
    <svg viewBox="0 0 64 14" preserveAspectRatio="none" className={cn("flow-ekg", compact ? "h-[12px] w-[30px]" : "h-[14px] w-[64px]")} aria-hidden="true" style={{ color: tone }}>
      <path d={offline ? EKG_FLAT : running ? EKG_D : EKG_FLAT} className="flow-ekg-base" strokeDasharray={offline ? "3 3" : undefined} />
      {running && !reduced && <path d={EKG_D} className="flow-ekg-sweep" pathLength={1} />}
    </svg>
  );
  return (
    <div
      className={cn("flow-machine absolute -translate-x-1/2 -translate-y-1/2", compact && "flow-machine--compact")}
      data-state={w.state}
      data-running={running}
      style={{ left: at.x, top: at.y, width: size.w, height: size.h, "--tone": tone } as React.CSSProperties}
      title={title}
    >
      {compact ? (
        <>
          <span className="flow-machine-name truncate">{w.name}</span>
          {ekg}
          {dots}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flow-machine-name truncate">{w.name}</span>
            {dots}
          </div>
          {ekg}
        </>
      )}
    </div>
  );
}

function Train({
  placed,
  now,
  compact,
  wide,
  hovered,
  onHover,
  vertical,
  travel,
  color,
  reduced,
}: {
  placed: Placed;
  now: number;
  compact: boolean;
  wide: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  vertical: boolean;
  travel: "fwd" | "back" | null;
  color: string;
  reduced: boolean;
}) {
  const { task: t, lane, pos, phase } = placed;
  const failed = t.station === "Failed";
  const running = t.station === "Running" && phase === "on";
  const worker = t.runner?.replace(/^runner:/, "") ?? null;
  const dwell = Math.max(0, now - new Date(t.since).getTime());
  const budget = BUDGET_MS[t.station];
  const fraction = Math.min(1, dwell / budget);
  const over = dwell > budget && t.station !== "Merged";
  const initial = (t.project[0] ?? t.repo[0] ?? "?").toUpperCase();
  const showRepo = wide;
  return (
    <div
      className={cn("flow-train-wrap absolute left-0 top-0", phase === "exit" && "flow-train-wrap--exit", phase === "enter" && "opacity-0")}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, zIndex: hovered ? 20 : 10, "--tail": failed ? "var(--bad)" : color } as React.CSSProperties}
      data-phase={phase}
      data-station={t.station}
      data-exit={phase === "exit" ? placed.exitVia : undefined}
      data-travel={travel ?? undefined}
      data-vertical={vertical}
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(t.id)}
      onBlur={() => onHover(null)}
    >
      <div className="relative -translate-x-1/2 -translate-y-1/2">
        <span className="flow-train-tail" aria-hidden="true" />
        <Link
          href={taskHref(t)}
          className={cn("flow-train", compact && "flow-train--compact", failed && "flow-train--failed", running && !reduced && "flow-train--running", "focus-visible:outline-2 focus-visible:outline-ring")}
          style={{ "--lane": failed ? "var(--bad)" : color, "--lane-raw": color } as React.CSSProperties}
          title={t.title}
          aria-label={`${t.id}: ${t.title}, ${t.station}${worker ? ` on ${worker}` : ""}, here for ${fmtDwell(t.since, now)}`}
          data-lane={lane}
        >
          <span className="flow-train-light" aria-hidden="true" />
          <span className={cn("flow-train-badge", over && "flow-train-badge--over")} aria-hidden="true">
            <svg viewBox="0 0 20 20" className="absolute inset-0 size-full">
              <circle cx="10" cy="10" r="8" className="flow-ring-track" />
              <circle cx="10" cy="10" r="8" className="flow-ring" pathLength={1} strokeDasharray={`${fraction} 1`} />
            </svg>
            <span className="flow-train-initial">{initial}</span>
          </span>
          {showRepo && <span className="flow-train-repo">{repoName(t)}</span>}
          <span className="flow-train-n">#{t.issue}</span>
          {t.preview_state === "failed" && t.station !== "Failed" && (
            <span className="flow-train-flag" title="preview failed">
              !
            </span>
          )}
        </Link>
        {hovered && phase !== "exit" && <HoverCard t={t} now={now} worker={worker} failed={failed} vertical={vertical} />}
      </div>
    </div>
  );
}

function HoverCard({ t, now, worker, failed, vertical }: { t: FlowTask; now: number; worker: string | null; failed: boolean; vertical: boolean }) {
  return (
    <div role="tooltip" className={cn("flow-card absolute left-1/2 z-30 w-60 -translate-x-1/2 rounded-md border bg-popover p-2.5 text-[11px] leading-4 text-popover-foreground", vertical ? "top-[32px]" : "bottom-[32px]")}>
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
  );
}

function Legend() {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-3">
        {FLOW_LANES.map((lane) => (
          <span key={lane} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-[5px] w-5 rounded-full" style={{ background: `var(${LANE_VAR[lane]})` }} aria-hidden="true" />
            <span>{LANE_LABEL[lane]}</span>
          </span>
        ))}
      </span>
      <span>ring on a train: time at this station against its budget, amber past it</span>
      <span>machine heartbeat: running · flat: idle · dashed: offline</span>
      <span>particles run only where a task is moving</span>
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

/** The compact strip for the top of the feed (about 220px tall). */
export function PipelineStrip({ initial = null, className }: { initial?: FlowSnapshot | null; className?: string }) {
  return <PipelineMap initial={initial} variant="strip" className={className} />;
}

/** Kept for callers that read the layout type. */
export type { Layout, OnLine };
