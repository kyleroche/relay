/** Plan-meter composition (lib/meters.ts): override, then the freshest worker reading per window, then none. */
import { describe, expect, it } from "vitest";
import type { MeterReading } from "@relay/core";
import { composeMeters, freshestReadings, meterSourceLine, NO_READING_NOTE, type MeterWorker } from "../lib/meters.ts";

const now = Date.parse("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const reading = (window: "5h" | "7d", used: number, ageMs: number): MeterReading => ({ subscription: "max", window, used_percentage: used, resets_at: new Date(now + 3 * 3_600_000).toISOString(), captured_at: ago(ageMs), source: "claude-statusline" });
const worker = (name: string, state: MeterWorker["state"], meters: MeterReading[]): MeterWorker => ({ name, host: `${name}.local`, state, meters });

describe("composeMeters", () => {
  it("with no workers, no override: two Claude bars with no reading and the note, then the no-meter vendors", () => {
    const m = composeMeters({ workers: [], now });
    expect(m.map((x) => [x.id, x.source, x.percentUsed])).toEqual([
      ["max-5h", "none", null],
      ["max-week", "none", null],
      ["codex-week", "none", null],
      ["grok-week", "none", null],
    ]);
    expect(m[0]!.note).toBe(NO_READING_NOTE);
    expect(meterSourceLine(m, now)).toMatch(/No reading yet/);
  });

  it("takes the freshest reading per window across online and idle workers, ignores offline and stale ones", () => {
    const workers = [
      worker("laptop", "online", [reading("5h", 42, 4 * 60_000), reading("7d", 44, 4 * 60_000)]),
      worker("mini", "idle", [reading("5h", 61, 60_000)]), // fresher 5h
      worker("gone", "offline", [reading("5h", 99, 1_000), reading("7d", 99, 1_000)]),
      worker("stale", "idle", [reading("7d", 98, 49 * 3_600_000)]),
    ];
    const best = freshestReadings(workers, now);
    expect(best.get("5h")).toMatchObject({ worker: "mini", reading: { used_percentage: 61 } });
    expect(best.get("7d")).toMatchObject({ worker: "laptop", reading: { used_percentage: 44 } });
    const m = composeMeters({ workers, now });
    expect(m[0]).toMatchObject({ id: "max-5h", source: "vendor", percentUsed: 61, worker: "mini", capturedAt: ago(60_000), resetsIn: "3h 0m" });
    expect(m[1]).toMatchObject({ id: "max-week", source: "vendor", percentUsed: 44, worker: "laptop" });
    expect(m).toHaveLength(4);
    expect(meterSourceLine(m, now)).toMatch(/Current reading from mini, 1m ago\.$/);
  });

  it("RELAY_PLAN_METERS overrides per id, supplies a third Claude meter, and a malformed value is ignored", () => {
    const workers = [worker("laptop", "online", [reading("5h", 42, 60_000), reading("7d", 44, 60_000)])];
    const override = JSON.stringify([
      { id: "max-week", label: "Weekly, all models", subscription: "max", percentUsed: 70.4, resetsAt: new Date(now + 86_400_000).toISOString() },
      { id: "max-week-fable", label: "Weekly, Fable", subscription: "max", percentUsed: 12 },
      { id: "bogus", label: "x", subscription: "nope", percentUsed: 1 },
    ]);
    const m = composeMeters({ override, workers, now });
    expect(m.map((x) => [x.id, x.source, x.percentUsed])).toEqual([
      ["max-5h", "vendor", 42],
      ["max-week", "manual", 70],
      ["max-week-fable", "manual", 12],
      ["codex-week", "none", null],
      ["grok-week", "none", null],
    ]);
    expect(m[1]!.resetsIn).toBe("24h 0m");
    expect(composeMeters({ override: "{not json", workers, now })[0]!.source).toBe("vendor");
    expect(meterSourceLine(composeMeters({ override, workers: [], now }), now)).toMatch(/set by hand in RELAY_PLAN_METERS/);
  });
});
