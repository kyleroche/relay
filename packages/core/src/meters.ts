/**
 * Plan meters are vendor numbers relay cannot compute from its own ledger (the ledger counts relay's runs, a
 * subscription counts everything the login did). The one documented source is Claude Code's status line: on every
 * refresh it hands its status-line command a JSON document that, for claude.ai Pro/Max logins, carries
 * `rate_limits.five_hour` and `rate_limits.seven_day` as `{ used_percentage, resets_at }`. relay's status-line script
 * (`packages/cli/hooks/statusline.mjs`, installed by `relay setup`) saves that under `~/.harness/meters/claude.json`;
 * the worker reads the directory on every heartbeat and sends the readings along, so the hosted site can show them.
 * Nothing in Codex or Grok is documented to publish the equivalent, so only Claude ever has a vendor meter.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MeterWindow = "5h" | "7d";
export const METER_WINDOWS: readonly MeterWindow[] = ["5h", "7d"];
export const METER_SOURCE = "claude-statusline";
/** A capture older than this is not reported: the login may have moved to another machine, or the status line stopped. */
export const METERS_MAX_AGE_MS = 48 * 3_600_000;

/** One window's reading as the worker sends it and the site stores it. */
export interface MeterReading {
  subscription: string;
  window: MeterWindow;
  used_percentage: number;
  /** When the window resets (ISO), null when the vendor did not say. */
  resets_at: string | null;
  /** When the status line saw it (ISO). */
  captured_at: string;
  source: typeof METER_SOURCE;
}

/** One `~/.harness/meters/<name>.json`, as statusline.mjs writes it. */
export interface MeterFile {
  subscription: string;
  five_hour: { used_percentage: number; resets_at: number | string | null } | null;
  seven_day: { used_percentage: number; resets_at: number | string | null } | null;
  captured_at: string;
}

export const metersDir = (home: string): string => join(home, "meters");

const pct = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined);

/** Claude Code gives `resets_at` in unix seconds; a file may already hold an ISO string. */
export function resetsAtIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

/** The readings in one meter file, or none when the file is malformed or older than `maxAgeMs`. */
export function readingsFromFile(j: unknown, opts: { now?: number; maxAgeMs?: number } = {}): MeterReading[] {
  if (!j || typeof j !== "object") return [];
  const f = j as Partial<MeterFile>;
  if (typeof f.captured_at !== "string" || Number.isNaN(Date.parse(f.captured_at))) return [];
  const capturedAt = new Date(f.captured_at).toISOString();
  const age = (opts.now ?? Date.now()) - Date.parse(capturedAt);
  if (age > (opts.maxAgeMs ?? METERS_MAX_AGE_MS)) return [];
  const subscription = typeof f.subscription === "string" && f.subscription.trim() ? f.subscription.trim().slice(0, 32) : "max";
  const out: MeterReading[] = [];
  for (const [key, window] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const w = f[key];
    const used = w ? pct(w.used_percentage) : undefined;
    if (!w || used === undefined) continue;
    out.push({ subscription, window, used_percentage: used, resets_at: resetsAtIso(w.resets_at), captured_at: capturedAt, source: METER_SOURCE });
  }
  return out;
}

/** Every fresh reading under `<home>/meters/*.json`; a missing directory or an unreadable file is simply no reading. */
export function readMeterFiles(home: string, opts: { now?: number; maxAgeMs?: number } = {}): MeterReading[] {
  const dir = metersDir(home);
  if (!existsSync(dir)) return [];
  const out: MeterReading[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  for (const n of names) {
    try {
      out.push(...readingsFromFile(JSON.parse(readFileSync(join(dir, n), "utf8")), opts));
    } catch {
      /* a half-written or foreign file: skip it */
    }
  }
  return out;
}

/** What the server accepts from a heartbeat: at most 20 well-formed readings, every field bounded. */
export function sanitizeMeters(input: unknown): MeterReading[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return [];
  const out: MeterReading[] = [];
  for (const r of input.slice(0, 20) as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") continue;
    const used = pct(r.used_percentage);
    const window = r.window as MeterWindow;
    if (used === undefined || !METER_WINDOWS.includes(window)) continue;
    if (typeof r.captured_at !== "string" || Number.isNaN(Date.parse(r.captured_at))) continue;
    out.push({
      subscription: typeof r.subscription === "string" && r.subscription.trim() ? r.subscription.trim().slice(0, 32) : "max",
      window,
      used_percentage: used,
      resets_at: resetsAtIso(r.resets_at),
      captured_at: new Date(r.captured_at).toISOString(),
      source: METER_SOURCE,
    });
  }
  return out;
}

/** "5h 42%, 7d 44%" for a status line or a doctor line. */
export function fmtMeterReadings(readings: MeterReading[]): string {
  return readings.map((r) => `${r.window} ${r.used_percentage}%`).join(", ");
}
