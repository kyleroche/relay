/** Meter files under $RELAY_HOME/meters (what statusline.mjs writes) become the readings a worker sends; junk is dropped. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtMeterReadings, METERS_MAX_AGE_MS, readingsFromFile, readMeterFiles, sanitizeMeters } from "../src/meters.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "relay-meters-"));
  mkdirSync(join(home, "meters"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const now = Date.parse("2026-10-17T12:00:00Z");
const file = (ageMs: number, extra: Record<string, unknown> = {}) => ({
  subscription: "max",
  five_hour: { used_percentage: 42, resets_at: 1_760_700_000 },
  seven_day: { used_percentage: 44.6, resets_at: 1_761_000_000 },
  captured_at: new Date(now - ageMs).toISOString(),
  ...extra,
});

describe("meter files", () => {
  it("reads both windows, converts resets_at from unix seconds, rounds and clamps the percentage", () => {
    const r = readingsFromFile(file(60_000), { now });
    expect(r).toEqual([
      { subscription: "max", window: "5h", used_percentage: 42, resets_at: "2025-10-17T11:20:00.000Z", captured_at: new Date(now - 60_000).toISOString(), source: "claude-statusline" },
      { subscription: "max", window: "7d", used_percentage: 45, resets_at: "2025-10-20T22:40:00.000Z", captured_at: new Date(now - 60_000).toISOString(), source: "claude-statusline" },
    ]);
    expect(readingsFromFile(file(0, { five_hour: { used_percentage: 140 }, seven_day: null }), { now })).toMatchObject([{ window: "5h", used_percentage: 100, resets_at: null }]);
    expect(fmtMeterReadings(r)).toBe("5h 42%, 7d 45%");
  });

  it("drops stale, malformed and foreign files, and reads the directory in name order", () => {
    writeFileSync(join(home, "meters", "claude.json"), JSON.stringify(file(5 * 60_000)));
    writeFileSync(join(home, "meters", "old.json"), JSON.stringify(file(METERS_MAX_AGE_MS + 1)));
    writeFileSync(join(home, "meters", "broken.json"), "{not json");
    writeFileSync(join(home, "meters", "other.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(home, "meters", "notes.txt"), "ignored");
    const r = readMeterFiles(home, { now });
    expect(r.map((x) => x.window)).toEqual(["5h", "7d"]);
    expect(readMeterFiles(home, { now, maxAgeMs: Number.POSITIVE_INFINITY })).toHaveLength(4);
    expect(readMeterFiles(join(home, "nope"), { now })).toEqual([]);
    expect(readingsFromFile(file(0, { captured_at: "yesterday-ish" }), { now })).toEqual([]);
  });

  it("sanitizes what a heartbeat sends: bounded, typed, at most 20", () => {
    expect(sanitizeMeters(undefined)).toBeUndefined();
    expect(sanitizeMeters("junk")).toEqual([]);
    const ok = { subscription: "max", window: "5h", used_percentage: 42, resets_at: "2026-10-17T15:00:00.000Z", captured_at: "2026-10-17T11:58:00.000Z", source: "claude-statusline" };
    expect(sanitizeMeters([ok, { window: "1y", used_percentage: 1, captured_at: ok.captured_at }, { window: "7d", used_percentage: "x", captured_at: ok.captured_at }, { window: "7d", used_percentage: 3 }, null])).toEqual([ok]);
    expect(sanitizeMeters([{ ...ok, subscription: "", used_percentage: -4, resets_at: 1_760_700_000, source: "forged" }])).toEqual([{ ...ok, used_percentage: 0, resets_at: "2025-10-17T11:20:00.000Z" }]);
    expect(sanitizeMeters(Array.from({ length: 30 }, () => ok))).toHaveLength(20);
  });
});
