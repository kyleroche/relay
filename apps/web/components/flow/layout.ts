/**
 * Geometry for the flow map (pipeline-map.tsx). Pure: pixel positions for rails, stations, project origins, machines
 * and the failed siding, for the full and strip variants, horizontal (lanes are rows) and vertical (lanes are
 * columns, under 640px). Every path is also available as a sampled polyline so the canvas layer (flow-canvas.tsx)
 * can run particles along it without parsing SVG path strings.
 */
import { STATIONS, type FlowLane, type Station } from "@/lib/flow";

export type Variant = "full" | "strip";
export type Orientation = "horizontal" | "vertical";
export type OnLine = Exclude<Station, "Failed">;

export interface Pt {
  x: number;
  y: number;
}

export const BREAK_PX = 640;
export const STATION_INDEX = new Map<Station, number>(STATIONS.map((s, i) => [s, i]));

/** A cubic bezier, kept as its control points so it can be both an SVG `d` and a sampled polyline. */
export interface Cubic {
  a: Pt;
  c1: Pt;
  c2: Pt;
  b: Pt;
}

export const cubicPath = ({ a, c1, c2, b }: Cubic): string => `M ${r(a.x)} ${r(a.y)} C ${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.x)} ${r(b.y)}`;
export const linePath = (a: Pt, b: Pt): string => `M ${r(a.x)} ${r(a.y)} L ${r(b.x)} ${r(b.y)}`;
const r = (n: number) => Math.round(n * 10) / 10;

export function sampleCubic({ a, c1, c2, b }: Cubic, n = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

interface Metrics {
  /** horizontal */
  projectX: number;
  queueX: number;
  mergedInset: number;
  laneTop: number;
  laneGap: number;
  machineY: number;
  labelY: number;
  sidingDy: number;
  /** vertical */
  gutter: number;
  rowTop: number;
  rowGap: number;
  projectRowY: number;
}

function metrics(variant: Variant, orientation: Orientation, width: number): Metrics {
  if (orientation === "vertical") {
    // the full variant's toolbar takes the first 30px; the strip has none
    const top = variant === "strip" ? 24 : 54;
    return { projectX: 0, queueX: 0, mergedInset: 0, laneTop: 0, laneGap: 0, machineY: top, labelY: 0, sidingDy: 0, gutter: 72, rowTop: top + 120, rowGap: variant === "strip" ? 46 : 62, projectRowY: top + 66 };
  }
  const narrow = width < 900;
  if (variant === "strip") {
    return { projectX: narrow ? 86 : 104, queueX: narrow ? 150 : 180, mergedInset: 52, laneTop: 92, laneGap: 34, machineY: 22, labelY: 64, sidingDy: 30, gutter: 0, rowTop: 0, rowGap: 0, projectRowY: 0 };
  }
  return { projectX: narrow ? 124 : 144, queueX: narrow ? 196 : 222, mergedInset: 66, laneTop: 162, laneGap: 68, machineY: 56, labelY: 122, sidingDy: 60, gutter: 0, rowTop: 0, rowGap: 0, projectRowY: 0 };
}

export interface Layout {
  variant: Variant;
  orientation: Orientation;
  width: number;
  height: number;
  lanes: FlowLane[];
  /** distance between neighbouring stations, to decide how much text a pill can carry */
  stationSpacing: number;
  /** Where a station sits on a lane. */
  at(lane: FlowLane, station: OnLine): Pt;
  /** The failed siding's anchor (first pill) for a lane. */
  siding(lane: FlowLane): Pt;
  sidingCurve: Cubic;
  sidingTail: [Pt, Pt];
  sidingLabel: Pt;
  stationLabel(station: OnLine): Pt;
  rail(lane: FlowLane): [Pt, Pt];
  segment(lane: FlowLane, from: OnLine, to: OnLine): [Pt, Pt];
  project(i: number, n: number): Pt;
  branch(from: Pt, lane: FlowLane): Cubic;
  machine(i: number, n: number): Pt;
  machineSize: { w: number; h: number };
  tether(machine: Pt, pill: Pt): Cubic;
  fan(i: number): Pt;
}

/**
 * `stack` is the deepest pile of trains at one stop (1..MAX_PER_STOP in pipeline-map.tsx): the gap between rails
 * (or station rows) grows with it so a crowded stop never spills onto the next lane.
 */
export function makeLayout(variant: Variant, width: number, lanes: FlowLane[], workerCount = 0, stack = 1): Layout {
  const orientation: Orientation = width < BREAK_PX ? "vertical" : "horizontal";
  const m = metrics(variant, orientation, width);
  const n = STATIONS.length;
  const deep = Math.max(0, stack - 2);
  m.laneGap += deep * (variant === "strip" ? 18 : 26);
  m.rowGap += deep * (variant === "strip" ? 18 : 22);
  const machineSize = orientation === "vertical" ? { w: 124, h: 30 } : variant === "strip" ? { w: 116, h: 28 } : { w: 108, h: 48 };

  if (orientation === "horizontal") {
    const mergedX = width - m.mergedInset;
    const laneY = (lane: FlowLane) => m.laneTop + Math.max(0, lanes.indexOf(lane)) * m.laneGap;
    const stationX = (s: OnLine) => m.queueX + ((mergedX - m.queueX) * (STATION_INDEX.get(s) ?? 0)) / (n - 1);
    const bottom = m.laneTop + (lanes.length - 1) * m.laneGap;
    const sidingY = bottom + m.sidingDy;
    const runX = stationX("Running");
    const height = sidingY + (variant === "strip" ? 24 : 40);
    const sidingStart = { x: runX, y: bottom };
    const sidingKnee = { x: runX + 44, y: sidingY };
    return {
      variant,
      orientation,
      width,
      height,
      lanes,
      stationSpacing: (mergedX - m.queueX) / (n - 1),
      at: (lane, s) => ({ x: stationX(s), y: laneY(lane) }),
      siding: () => ({ x: runX + 64, y: sidingY }),
      sidingCurve: { a: sidingStart, c1: { x: runX, y: bottom + m.sidingDy * 0.75 }, c2: { x: runX + 8, y: sidingY }, b: sidingKnee },
      sidingTail: [sidingKnee, { x: runX + 160, y: sidingY }],
      sidingLabel: { x: runX + 172, y: sidingY },
      stationLabel: (s) => ({ x: stationX(s), y: m.labelY }),
      rail: (lane) => [
        { x: m.queueX, y: laneY(lane) },
        { x: mergedX, y: laneY(lane) },
      ],
      segment: (lane, a, b) => [
        { x: stationX(a), y: laneY(lane) },
        { x: stationX(b), y: laneY(lane) },
      ],
      project: (i, count) => {
        const span = Math.max(0, lanes.length - 1) * m.laneGap;
        const y = count <= 1 ? m.laneTop + span / 2 : m.laneTop + (span * i) / (count - 1);
        return { x: m.projectX, y };
      },
      branch: (from, lane) => {
        const to = { x: m.queueX, y: laneY(lane) };
        const cx = from.x + (to.x - from.x) * 0.5;
        return { a: { x: from.x + 7, y: from.y }, c1: { x: cx, y: from.y }, c2: { x: cx, y: to.y }, b: to };
      },
      machine: (i, count) => {
        const gap = Math.min(machineSize.w + 16, (mergedX - m.queueX) / Math.max(1, count));
        return { x: runX + (i - (count - 1) / 2) * gap, y: m.machineY };
      },
      machineSize,
      tether: (mc, pill) => {
        const a = { x: mc.x, y: mc.y + machineSize.h / 2 };
        const b = { x: pill.x, y: pill.y - (variant === "strip" ? 10 : 13) };
        const dy = Math.max(24, (b.y - a.y) * 0.55);
        return { a, c1: { x: a.x, y: a.y + dy }, c2: { x: b.x, y: b.y - dy }, b };
      },
      fan: (i) => ({ x: 0, y: i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (variant === "strip" ? 18 : 26) }),
    };
  }

  // vertical: lanes are columns, stations are rows; the machines wrap into rows of chips, pushing everything down
  const perRow = Math.max(1, Math.floor((width - 16) / (machineSize.w + 8)));
  const machineRows = Math.max(1, Math.ceil(workerCount / perRow));
  const shift = (machineRows - 1) * (machineSize.h + 8);
  m.rowTop += shift;
  m.projectRowY += shift;
  // the failed siding gets its own column on the right, clear of the last lane
  const inner = width - m.gutter - 16 - 64;
  const laneX = (lane: FlowLane) => m.gutter + (inner * (Math.max(0, lanes.indexOf(lane)) + 0.5)) / lanes.length;
  const stationY = (s: OnLine) => m.rowTop + (STATION_INDEX.get(s) ?? 0) * m.rowGap;
  const runY = stationY("Running");
  const sidingY = runY + m.rowGap / 2;
  const sidingX = width - 44;
  const height = stationY("Merged") + 48;
  const rightLane = lanes[lanes.length - 1] ?? "claude";
  const sidingKnee = { x: sidingX - 24, y: sidingY };
  return {
    variant,
    orientation,
    width,
    height,
    lanes,
    stationSpacing: inner / lanes.length,
    at: (lane, s) => ({ x: laneX(lane), y: stationY(s) }),
    siding: () => ({ x: sidingX, y: sidingY }),
    sidingCurve: { a: { x: laneX(rightLane), y: runY }, c1: { x: laneX(rightLane), y: sidingY }, c2: { x: laneX(rightLane) + 16, y: sidingY }, b: sidingKnee },
    sidingTail: [sidingKnee, { x: width - 8, y: sidingY }],
    sidingLabel: { x: width - 8, y: sidingY + 16 },
    stationLabel: (s) => ({ x: 8, y: stationY(s) }),
    rail: (lane) => [
      { x: laneX(lane), y: m.rowTop },
      { x: laneX(lane), y: stationY("Merged") },
    ],
    segment: (lane, a, b) => [
      { x: laneX(lane), y: stationY(a) },
      { x: laneX(lane), y: stationY(b) },
    ],
    project: (i, count) => ({ x: m.gutter + (inner * (i + 0.5)) / Math.max(1, count), y: m.projectRowY }),
    branch: (from, lane) => {
      const to = { x: laneX(lane), y: m.rowTop };
      const cy = from.y + (to.y - from.y) * 0.5;
      return { a: { x: from.x, y: from.y + 7 }, c1: { x: from.x, y: cy }, c2: { x: to.x, y: cy }, b: to };
    },
    machine: (i, count) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, count - row * perRow);
      const rowWidth = inRow * machineSize.w + (inRow - 1) * 8;
      return { x: (width - rowWidth) / 2 + col * (machineSize.w + 8) + machineSize.w / 2, y: m.machineY + row * (machineSize.h + 8) };
    },
    machineSize,
    tether: (mc, pill) => {
      const a = { x: mc.x, y: mc.y + machineSize.h / 2 };
      const b = { x: pill.x, y: pill.y - 11 };
      const dy = Math.max(30, (b.y - a.y) * 0.5);
      return { a, c1: { x: a.x, y: a.y + dy }, c2: { x: b.x, y: b.y - dy }, b };
    },
    fan: (i) => ({ x: 0, y: i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 20 }),
  };
}
