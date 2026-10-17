/**
 * Plan meters for the header and /usage. The numbers are the vendor's, not relay's: the ledger counts relay's own runs,
 * a subscription counts everything the login did. The one documented source is Claude Code's status line, which
 * `relay setup` points at relay's script; it saves the 5-hour and 7-day used percentages under ~/.harness/meters and
 * `relay work` sends them with every heartbeat (packages/core/src/meters.ts). Composition, in priority:
 *
 *   1. RELAY_PLAN_METERS, a JSON array of { id, label, subscription, percentUsed, resetsAt, note? }: a manual override
 *      per meter id (source `manual`). It is also the only way to show a third Claude meter (a per-model weekly one);
 *      nothing documented reports that.
 *   2. The freshest reading per window across online and idle workers, no older than 48 hours (source `vendor`).
 *   3. Otherwise `percentUsed: null` with a note saying how to get a reading (source `none`).
 *
 * Codex and Grok publish no meter; their entries stay `none` with a note that says so, so the usage page can say it.
 */
import { METERS_MAX_AGE_MS, type MeterReading, type MeterWindow } from "@relay/core";
import { fmtAgo, fmtUntil } from "./format.ts";
import type { PlanMeter, Subscription, WorkerStatus } from "./types.ts";

export const NO_READING_NOTE = "No reading yet. Install relay's status line with `relay setup` on a machine that uses Claude Code.";

/** The worker fields composition needs; `WorkerView` from @relay/core satisfies it. */
export interface MeterWorker {
  name: string;
  host?: string;
  state: WorkerStatus;
  meters: MeterReading[];
}

const SUBSCRIPTIONS: Subscription[] = ["max", "codex", "grok", "gateway"];
const CLAUDE: Array<{ id: string; label: string; window: MeterWindow }> = [
  { id: "max-5h", label: "5-hour", window: "5h" },
  { id: "max-week", label: "Weekly, all models", window: "7d" },
];
const NO_METER: PlanMeter[] = [
  { id: "codex-week", label: "Weekly", subscription: "codex", percentUsed: null, resetsAt: null, resetsIn: null, source: "none", capturedAt: null, worker: null, note: "Codex publishes no plan meter; see calls and cost equivalent instead." },
  { id: "grok-week", label: "Weekly", subscription: "grok", percentUsed: null, resetsAt: null, resetsIn: null, source: "none", capturedAt: null, worker: null, note: "SuperGrok publishes no plan meter." },
];

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** The RELAY_PLAN_METERS override, keyed by meter id; empty when unset or malformed. */
export function parseOverride(raw: string | undefined, now: number): Map<string, PlanMeter> {
  const out = new Map<string, PlanMeter>();
  if (!raw?.trim()) return out;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return out;
    for (const m of list as Array<Partial<PlanMeter>>) {
      if (!m || typeof m.id !== "string" || typeof m.label !== "string" || !SUBSCRIPTIONS.includes(m.subscription as Subscription)) continue;
      const resetsAt = typeof m.resetsAt === "string" && !Number.isNaN(Date.parse(m.resetsAt)) ? m.resetsAt : null;
      out.set(m.id, {
        id: m.id,
        label: m.label,
        subscription: m.subscription as Subscription,
        percentUsed: typeof m.percentUsed === "number" && Number.isFinite(m.percentUsed) ? clamp(m.percentUsed) : null,
        resetsAt,
        resetsIn: resetsAt ? fmtUntil(resetsAt, now) : null,
        source: "manual",
        capturedAt: null,
        worker: null,
        ...(typeof m.note === "string" && m.note ? { note: m.note } : {}),
      });
    }
  } catch {
    /* a malformed override is no override */
  }
  return out;
}

/** The freshest reading per window across the workers that are not offline, no older than `maxAgeMs`. */
export function freshestReadings(workers: MeterWorker[], now: number, maxAgeMs: number = METERS_MAX_AGE_MS): Map<MeterWindow, { reading: MeterReading; worker: string }> {
  const best = new Map<MeterWindow, { reading: MeterReading; worker: string }>();
  for (const w of workers) {
    if (w.state === "offline") continue;
    for (const r of w.meters ?? []) {
      const t = Date.parse(r.captured_at);
      if (Number.isNaN(t) || now - t > maxAgeMs || t > now + 60_000) continue;
      const cur = best.get(r.window);
      if (!cur || Date.parse(cur.reading.captured_at) < t) best.set(r.window, { reading: r, worker: w.name });
    }
  }
  return best;
}

export interface ComposeInput {
  /** RELAY_PLAN_METERS, if set. */
  override?: string | undefined;
  workers: MeterWorker[];
  now?: number;
}

/** The meters the header and /usage show: Claude's two windows first (three with a manual third), then the no-meter vendors. */
export function composeMeters(input: ComposeInput): PlanMeter[] {
  const now = input.now ?? Date.now();
  const manual = parseOverride(input.override, now);
  const vendor = freshestReadings(input.workers, now);
  const out: PlanMeter[] = [];
  for (const c of CLAUDE) {
    const m = manual.get(c.id);
    if (m) {
      manual.delete(c.id);
      out.push(m);
      continue;
    }
    const v = vendor.get(c.window);
    if (v) {
      out.push({
        id: c.id,
        label: c.label,
        subscription: "max",
        percentUsed: v.reading.used_percentage,
        resetsAt: v.reading.resets_at,
        resetsIn: v.reading.resets_at ? fmtUntil(v.reading.resets_at, now) : null,
        source: "vendor",
        capturedAt: v.reading.captured_at,
        worker: v.worker,
      });
      continue;
    }
    out.push({ id: c.id, label: c.label, subscription: "max", percentUsed: null, resetsAt: null, resetsIn: null, source: "none", capturedAt: null, worker: null, note: NO_READING_NOTE });
  }
  // any other manual meter (a per-model weekly, a Codex number someone typed in) follows, then the vendors without one
  for (const m of manual.values()) out.push(m);
  for (const n of NO_METER) if (!out.some((m) => m.id === n.id)) out.push(n);
  return out;
}

/**
 * The line /usage prints under the meters: what they are (the vendor's numbers, read by relay's status line on a
 * worker and sent with its heartbeat), the machine and age of the current reading, or how to get one; demo and manual
 * numbers are named as such.
 */
export function meterSourceLine(meters: PlanMeter[], now: number = Date.now()): string {
  const base = "Plan usage is the vendor's number, not relay's ledger (which counts only relay's runs). Claude Code hands its 5-hour and weekly rate limits to its status line; `relay setup` points that at relay's script, which saves them under ~/.harness/meters, and `relay work` sends them with each heartbeat. Codex and Grok publish no meter.";
  const vendor = meters.filter((m) => m.source === "vendor" && m.capturedAt);
  if (vendor.length) {
    const freshest = vendor.reduce((a, b) => (Date.parse(b.capturedAt!) > Date.parse(a.capturedAt!) ? b : a));
    return `${base} Current reading from ${freshest.worker ?? "a worker"}, ${fmtAgo(freshest.capturedAt!, now)}.`;
  }
  if (meters.some((m) => m.source === "demo")) return `${base} These are demo numbers.`;
  if (meters.some((m) => m.source === "manual")) return `${base} These are set by hand in RELAY_PLAN_METERS.`;
  return `${base} No reading yet: run relay setup --yes on a machine that uses Claude Code, start one interactive claude session there, and keep relay work running.`;
}
