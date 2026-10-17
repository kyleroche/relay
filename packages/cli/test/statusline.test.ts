/**
 * The status-line script (hooks/statusline.mjs): saves Claude Code's rate limits under $RELAY_HOME/meters/claude.json
 * (atomic, 0600), prints a compact line by default, runs a remembered previous status line with the same stdin and
 * passes its output through, and never prints or fails on bad input.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readMeterFiles } from "@relay/core";

const SCRIPT = resolve(import.meta.dirname, "..", "hooks", "statusline.mjs");
let tmp: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-statusline-"));
  home = join(tmp, "harness");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(input: string) {
  const r = spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { ...process.env, RELAY_HOME: home }, timeout: 20_000 });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const payload = {
  model: { id: "claude-fable-5-1", display_name: "Fable" },
  workspace: { current_dir: "/Users/kyle/code/relay" },
  cwd: "/Users/kyle/code/relay",
  rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1_760_700_000 }, seven_day: { used_percentage: 44, resets_at: 1_761_000_000 } },
};

describe("statusline.mjs", () => {
  it("writes the meters file (0600, dir 0700) and prints the default line", () => {
    const r = run(JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.out).toBe("Fable · relay · 5h 42% · 7d 44%\n");
    const file = join(home, "meters", "claude.json");
    const j = JSON.parse(readFileSync(file, "utf8")) as { subscription: string; five_hour: { used_percentage: number; resets_at: number }; seven_day: { used_percentage: number }; captured_at: string };
    expect(j.subscription).toBe("max");
    expect(j.five_hour).toEqual({ used_percentage: 42, resets_at: 1_760_700_000 });
    expect(j.seven_day.used_percentage).toBe(44);
    expect(Math.abs(Date.now() - Date.parse(j.captured_at))).toBeLessThan(60_000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "meters")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, "meters", `.claude.${process.pid}.tmp`))).toBe(false);
    // the core reader sees the same two readings the worker will send
    const readings = readMeterFiles(home);
    expect(readings.map((x) => [x.window, x.used_percentage, x.resets_at])).toEqual([
      ["5h", 42, new Date(1_760_700_000_000).toISOString()],
      ["7d", 44, new Date(1_761_000_000_000).toISOString()],
    ]);
    expect(readings[0]!.source).toBe("claude-statusline");
  });

  it("keeps a window out when Claude Code omits it, and writes nothing without rate_limits", () => {
    const r = run(JSON.stringify({ ...payload, rate_limits: { five_hour: { used_percentage: 7, resets_at: 1 } } }));
    expect(r.out).toBe("Fable · relay · 5h 7%\n");
    expect(JSON.parse(readFileSync(join(home, "meters", "claude.json"), "utf8")).seven_day).toBeNull();

    rmSync(join(home, "meters"), { recursive: true, force: true });
    const none = run(JSON.stringify({ model: payload.model, cwd: "/tmp/x" }));
    expect(none).toMatchObject({ status: 0, out: "Fable · x\n" });
    expect(existsSync(join(home, "meters"))).toBe(false);
  });

  it("runs the previous status line with the same stdin and passes its output through", () => {
    mkdirSync(home, { recursive: true });
    const prev = join(tmp, "prev.cjs");
    writeFileSync(prev, 'const j = JSON.parse(require("node:fs").readFileSync(0, "utf8")); process.stdout.write("prev:" + j.model.display_name + ":" + j.rate_limits.five_hour.used_percentage + "\\n");');
    writeFileSync(join(home, "statusline.prev.json"), JSON.stringify({ type: "command", command: `"${process.execPath}" "${prev}"` }));
    const r = run(JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.out).toBe("prev:Fable:42.4\n");
    // the meters were still saved on the way
    expect(readMeterFiles(home)).toHaveLength(2);
  });

  it("prints nothing and exits 0 on bad input", () => {
    expect(run("not json")).toMatchObject({ status: 0, out: "" });
    expect(run("")).toMatchObject({ status: 0, out: "" });
    expect(run("[1,2]")).toMatchObject({ status: 0, out: "" });
    expect(run(JSON.stringify({ rate_limits: "nope" }))).toMatchObject({ status: 0, out: "" });
    expect(existsSync(join(home, "meters"))).toBe(false);
  });
});
