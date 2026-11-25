/**
 * `relay steps check` as a command, with a scripted lane in place of the vendor CLIs: the cases relay ships are
 * found, each run is printed and recorded as usage, and a failure is exit code 1. No model runs here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneRequest, LaneRunner } from "@relay/core";

let core: typeof import("@relay/core");
let registerSteps: typeof import("../src/commands/steps.ts").registerSteps;
let tmp: string;
let dir: string;

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-steps-check-cli-")));
  dir = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  // RELAY_HOME is read when @relay/core loads
  process.env.RELAY_HOME = join(tmp, "harness");
  core = await import("@relay/core");
  ({ registerSteps } = await import("../src/commands/steps.ts"));
});
afterAll(() => {
  delete process.env.RELAY_HOME;
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  process.exitCode = 0;
});

const ok = (lane: string, text: string) => ({ tool: lane, ok: true, text, model: `test/${lane}`, subscription: "max" as const, tokensIn: 100, tokensOut: 20, cacheRead: 0, cacheWrite: 0, costEquiv: 0.02, durationMs: 1000 });
const isJudge = (req: LaneRequest): boolean => req.prompt.startsWith("# relay step check: judge");

/** A lane that removes the two noise comments of remove-yap/narration when `good`, and a judge that passes everything. */
function lane(good: boolean) {
  const calls: string[] = [];
  const run: LaneRunner = async (req, on) => {
    calls.push(`${on}:${isJudge(req) ? "judge" : "step"}`);
    if (isJudge(req)) return ok(on, '{"pass": true, "reason": "the noise is gone and the reason stayed"}');
    const file = join(req.cwd, "src", "retry.js");
    if (good && existsSync(file)) writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((l) => !/\/\/ (Added exponential|wait before)/.test(l)).join("\n"));
    return ok(on, good ? "Removed 2 comments in 1 file." : "Nothing to remove.");
  };
  return { calls, run };
}

async function check(l: ReturnType<typeof lane>, ...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
  const error = vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
  try {
    const p = new Command().exitOverride();
    registerSteps(p, { laneRun: l.run, lanes: async () => ["claude", "codex"] });
    await p.parseAsync(["node", "relay", "steps", "check", ...args, "--cwd", dir]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out: out.join("\n"), err: err.join("\n"), code: Number(process.exitCode ?? 0) };
}

async function usageRows(): Promise<number> {
  const h = await core.openHarness();
  try {
    await core.migrate(h.db);
    return (await core.repo.listEvents(h.db, { kind: "step.usage", limit: 1000 })).length;
  } finally {
    await h.close();
  }
}

describe("relay steps check", () => {
  it("passes a case when every run passes: the step on its lane, the grade on the other, each call a usage row", async () => {
    const l = lane(true);
    const before = await usageRows();
    const r = await check(l, "remove-yap", "--case", "narration", "--repeat", "2");
    expect(r.code).toBe(0);
    expect(l.calls).toEqual(["claude:step", "codex:judge", "claude:step", "codex:judge"]);
    expect(r.out).toContain("remove-yap/narration  run 1/2  pass  (2s, $0.04 equiv)  codex: the noise is gone and the reason stayed");
    expect(r.out).toContain("remove-yap/narration  run 2/2  pass");
    expect(r.out).toContain("remove-yap/narration  pass (2 of 2 runs)");
    expect(r.err).toMatch(/1 case, up to 2 runs each on the claude lane, graded by the codex lane: at most 4 model calls/);
    expect(r.err).toContain("all 1 case passed");
    expect(await usageRows()).toBe(before + 4);
    expect(existsSync(join(tmp, "harness", "work", "checks", "remove-yap-narration"))).toBe(false);
  });

  it("exits 1 when a run fails, says which expectation, and makes no further runs of that case", async () => {
    const l = lane(false);
    const r = await check(l, "remove-yap", "--lane", "codex", "--judge", "claude");
    expect(r.code).toBe(1);
    // narration and stale fail at their first run; nothing-to-do is left alone three times, as it should be
    expect(l.calls.filter((c) => c === "codex:step")).toHaveLength(5);
    expect(l.calls.filter((c) => c === "claude:judge")).toHaveLength(3);
    expect(r.out).toContain("remove-yap/narration  run 1/3  FAIL");
    expect(r.out).toContain("  must_remove: // Added exponential backoff as requested in the task. is still in src/retry.js");
    expect(r.out).toContain("  the codex lane's last words: Nothing to remove.");
    expect(r.out).toContain("remove-yap/narration  FAIL (2 more runs not made: a case passes only when every run does)");
    expect(r.out).toContain("remove-yap/nothing-to-do  pass (3 of 3 runs)");
    expect(r.err).toContain("2 of 3 cases failed: narration, stale");
  });

  it("prints one JSON document for a machine", async () => {
    const r = await check(lane(true), "remove-yap", "--case", "narration", "--repeat", "1", "--json");
    const j = JSON.parse(r.out) as { step: string; lane: string; judge: string; pass: boolean; cases: Array<{ case: string; pass: boolean; runs: unknown[] }> };
    expect(j).toMatchObject({ step: "remove-yap", lane: "claude", judge: "codex", repeat: 1, pass: true });
    expect(j.cases).toMatchObject([{ case: "narration", pass: true }]);
  });

  it("refuses a step with no checks, a case that does not exist, and a lane that is not a code lane, before any model call", async () => {
    const l = lane(true);
    await expect(check(l, "eval-respond")).rejects.toThrow(/no checks for 'eval-respond'/);
    await expect(check(l, "remove-yap", "--case", "nope")).rejects.toThrow(/has no case 'nope'; it has narration, nothing-to-do, stale/);
    await expect(check(l, "remove-yap", "--lane", "nodes")).rejects.toThrow(/'nodes' is not a code lane/);
    await expect(check(l, "remove-yap", "--repeat", "0")).rejects.toThrow(/--repeat is a whole number/);
    expect(l.calls).toEqual([]);
  });
});
