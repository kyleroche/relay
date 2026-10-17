"use client";

/**
 * The flow map's canvas layers: a drifting dot grid (two layers, slow parallax) under the SVG, and streams of
 * particles along the tracks that carry activity (rail segments, project branches, worker tethers) over it, so the
 * light rides on top of the rails. One requestAnimationFrame loop drives both, sized to the container at
 * devicePixelRatio, paused while the tab is hidden or the map is scrolled out of view. With `prefers-reduced-motion`
 * it paints the grid once and runs nothing.
 */
import { useEffect, useRef } from "react";
import type { Pt } from "./layout";

export interface Track {
  key: string;
  color: string;
  kind: "rail" | "branch" | "tether";
  /** sampled polyline, in CSS pixels */
  pts: Pt[];
  /** 0..1: how busy the track is; scales particle count and speed */
  density: number;
}

interface Particle {
  d: number;
  speed: number;
  size: number;
  /** 0..1 brightness jitter */
  glow: number;
}

interface Live {
  track: Track;
  length: number;
  cum: number[];
  particles: Particle[];
}

const MAX_PARTICLES = 360;
const GRID = 28;

function measure(pts: Pt[]): { cum: number[]; length: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { cum, length: cum[cum.length - 1] ?? 0 };
}

function prepare(track: Track): Live {
  const { cum, length } = measure(track.pts);
  const per = track.kind === "tether" ? 44 : track.kind === "branch" ? 30 : 22;
  const count = Math.max(2, Math.min(18, Math.round((length / per) * (0.6 + track.density * 0.8))));
  const base = track.kind === "tether" ? 150 : track.kind === "branch" ? 85 : 110;
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      d: Math.random() * length,
      speed: base * (0.75 + Math.random() * 0.5) * (0.8 + track.density * 0.5),
      size: (track.kind === "tether" ? 1.8 : 1.4) + Math.random() * 1,
      glow: 0.55 + Math.random() * 0.45,
    });
  }
  return { track, length, cum, particles };
}

/** Keep a track's particles when only its geometry or density changed, so a poll never re-seeds the streams. */
function refresh(live: Live, track: Track): Live {
  if (live.track.pts === track.pts) return { ...live, track };
  const { cum, length } = measure(track.pts);
  const ratio = live.length > 0 ? length / live.length : 1;
  for (const p of live.particles) p.d = (p.d * ratio) % Math.max(1, length);
  return { track, cum, length, particles: live.particles };
}

function pointAt(live: Live, d: number): Pt {
  const { cum, track } = live;
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < d) i++;
  const a = track.pts[i - 1]!;
  const b = track.pts[i]!;
  const span = cum[i]! - cum[i - 1]!;
  const t = span > 0 ? (d - cum[i - 1]!) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function gridTile(size: number, color: string, dot: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.beginPath();
  g.arc(size / 2, size / 2, dot, 0, Math.PI * 2);
  g.fill();
  return c;
}

const isDark = () => document.documentElement.classList.contains("dark");

function paintGrid(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number, drift: number, dark: boolean) {
  const fineTile = gridTile(GRID, dark ? "rgba(255,255,255,0.085)" : "rgba(20,24,40,0.12)", 0.9);
  const coarseTile = gridTile(GRID * 3, dark ? "rgba(255,255,255,0.13)" : "rgba(20,24,40,0.17)", 1.3);
  const fine = ctx.createPattern(fineTile, "repeat");
  const coarse = ctx.createPattern(coarseTile, "repeat");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (coarse) {
    ctx.save();
    ctx.translate((-drift * 0.35) % (GRID * 3), (-drift * 0.2) % (GRID * 3));
    ctx.fillStyle = coarse;
    ctx.fillRect(-GRID * 3, -GRID * 3, width + GRID * 6, height + GRID * 6);
    ctx.restore();
  }
  if (fine) {
    ctx.save();
    ctx.translate((-drift * 0.9) % GRID, (-drift * 0.55) % GRID);
    ctx.fillStyle = fine;
    ctx.fillRect(-GRID, -GRID, width + GRID * 2, height + GRID * 2);
    ctx.restore();
  }
}

function paintMessage(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, width: number, height: number, msg: string, dark: boolean) {
  const family = getComputedStyle(canvas).fontFamily || "ui-sans-serif, system-ui, sans-serif";
  ctx.save();
  ctx.font = `500 13px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = dark ? "rgba(255,255,255,0.6)" : "rgba(20,24,40,0.6)";
  ctx.fillText(msg, width / 2, height * 0.52);
  ctx.restore();
}

export interface FlowCanvasProps {
  tracks: Track[];
  width: number;
  height: number;
  reduced: boolean;
  /** false pauses the loop (the map's pause toggle) */
  running: boolean;
  /** the panel's empty-state line, drawn in the canvas so the surface itself says it */
  message?: string | null;
}

/** The grid layer (under the SVG). */
export function FlowGrid({ width, height, reduced, running, message }: Omit<FlowCanvasProps, "tracks">) {
  const ref = useRef<HTMLCanvasElement>(null);
  const msgRef = useRef(message);
  msgRef.current = message;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    let raf = 0;
    let last = 0;
    let drift = 0;
    let visible = document.visibilityState !== "hidden";
    let inView = true;

    const paint = () => {
      const dark = isDark();
      paintGrid(ctx, width, height, dpr, drift, dark);
      if (msgRef.current) paintMessage(ctx, canvas, width, height, msgRef.current, dark);
    };
    const frame = (now: number) => {
      raf = 0;
      if (!visible || !inView || !running) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      drift += dt * 6;
      paint();
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf || reduced) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    paint();
    const mo = new MutationObserver(paint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (reduced) return () => mo.disconnect();

    const onVis = () => {
      visible = document.visibilityState !== "hidden";
      if (visible) start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (inView) start();
      else stop();
    });
    io.observe(canvas);
    start();
    return () => {
      stop();
      mo.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [width, height, reduced, running, message]);

  return <canvas ref={ref} className="flow-canvas flow-canvas--grid pointer-events-none absolute inset-0" aria-hidden="true" />;
}

/** The particle layer (over the SVG, under the HTML). */
export function FlowParticles({ tracks, width, height, reduced, running }: Omit<FlowCanvasProps, "message">) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tracksRef = useRef(tracks);
  const liveRef = useRef(new Map<string, Live>());
  tracksRef.current = tracks;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (reduced) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return;
    }

    let raf = 0;
    let last = 0;
    let visible = document.visibilityState !== "hidden";
    let inView = true;

    const sync = () => {
      const next = new Map<string, Live>();
      for (const t of tracksRef.current) {
        const cur = liveRef.current.get(t.key);
        next.set(t.key, cur ? refresh(cur, t) : prepare(t));
      }
      let total = 0;
      for (const l of next.values()) total += l.particles.length;
      if (total > MAX_PARTICLES) {
        const scale = MAX_PARTICLES / total;
        for (const l of next.values()) l.particles = l.particles.slice(0, Math.max(1, Math.floor(l.particles.length * scale)));
      }
      liveRef.current = next;
    };

    const frame = (now: number) => {
      raf = 0;
      if (!visible || !inView || !running) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const dark = isDark();
      sync();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const live of liveRef.current.values()) {
        if (live.length < 2) continue;
        const onRail = live.track.kind === "rail";
        for (const p of live.particles) {
          p.d += p.speed * dt;
          if (p.d > live.length) p.d -= live.length;
          const { x, y } = pointAt(live, p.d);
          const edge = Math.min(1, Math.min(p.d, live.length - p.d) / 28);
          const a = edge * p.glow;
          // halo in the lane colour, core white-hot on dark (the light rides the rail), lane-coloured ink on paper
          ctx.fillStyle = live.track.color;
          ctx.globalAlpha = a * (dark ? 0.3 : 0.16);
          ctx.beginPath();
          ctx.arc(x, y, p.size * 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = dark ? "#fff" : onRail ? "#fff" : live.track.color;
          ctx.globalAlpha = a * (dark ? 0.92 : onRail ? 0.85 : 0.9);
          ctx.beginPath();
          ctx.arc(x, y, p.size * (dark ? 1 : 1.1), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVis = () => {
      visible = document.visibilityState !== "hidden";
      if (visible) start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (inView) start();
      else stop();
    });
    io.observe(canvas);
    start();
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [width, height, reduced, running]);

  return <canvas ref={ref} className="flow-canvas flow-canvas--particles pointer-events-none absolute inset-0" aria-hidden="true" />;
}
