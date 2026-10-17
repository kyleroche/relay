#!/usr/bin/env node
// Claude Code status line (settings.json `statusLine.command`, installed by `relay setup`). Claude Code passes a JSON
// document on stdin on every refresh; for claude.ai Pro/Max logins it carries `rate_limits.five_hour` and
// `rate_limits.seven_day` as { used_percentage, resets_at } (unix seconds), the only documented source of the plan
// meters the web app's header shows. This script:
//   1. saves them to <RELAY_HOME>/meters/claude.json (atomic write, 0600; the directory 0700) when present;
//   2. prints the status line: the command that was there before `relay setup` (recorded in
//      <RELAY_HOME>/statusline.prev.json) is run with the same stdin and its output passed through, so a user's own
//      status line keeps working; otherwise a compact default: `<model> · <cwd> · 5h 42% · 7d 44%`.
// Nothing here can break a session: on any error it prints nothing and exits 0. Stays dependency-free and reads no
// other file than those two, because it runs on every refresh.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const RELAY_HOME = process.env.RELAY_HOME ?? join(homedir(), ".harness");
const METERS_DIR = join(RELAY_HOME, "meters");
const PREV_PATH = join(RELAY_HOME, "statusline.prev.json");

function main() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  const limits = payload.rate_limits;
  let meters = null;
  if (limits && typeof limits === "object") {
    meters = { subscription: "max", five_hour: windowOf(limits.five_hour), seven_day: windowOf(limits.seven_day), captured_at: new Date().toISOString() };
    try {
      writeMeters(meters);
    } catch {
      /* a read-only home: the status line still prints */
    }
  }

  const prev = previousCommand();
  if (prev) {
    const cwd = typeof payload.cwd === "string" && existsSync(payload.cwd) ? payload.cwd : undefined;
    const r = spawnSync(prev, { shell: true, input: raw, encoding: "utf8", timeout: 5000, env: process.env, ...(cwd ? { cwd } : {}), stdio: ["pipe", "pipe", "ignore"] });
    if (!r.error && typeof r.stdout === "string") process.stdout.write(r.stdout);
    return;
  }
  const parts = [];
  const model = payload.model && typeof payload.model.display_name === "string" ? payload.model.display_name : "";
  if (model) parts.push(model);
  const dir = (payload.workspace && typeof payload.workspace.current_dir === "string" && payload.workspace.current_dir) || (typeof payload.cwd === "string" ? payload.cwd : "");
  if (dir) parts.push(basename(dir));
  if (meters?.five_hour) parts.push(`5h ${meters.five_hour.used_percentage}%`);
  if (meters?.seven_day) parts.push(`7d ${meters.seven_day.used_percentage}%`);
  if (parts.length) process.stdout.write(parts.join(" · ") + "\n");
}

/** { used_percentage, resets_at } with the percentage clamped to 0..100, or null when the window is absent. */
function windowOf(w) {
  if (!w || typeof w !== "object" || typeof w.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) return null;
  const resets = typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at : null;
  return { used_percentage: Math.max(0, Math.min(100, Math.round(w.used_percentage))), resets_at: resets };
}

/** Write <METERS_DIR>/claude.json: temp file beside it, 0600, then rename, so a reader never sees half a file. */
function writeMeters(meters) {
  mkdirSync(METERS_DIR, { recursive: true, mode: 0o700 });
  const target = join(METERS_DIR, "claude.json");
  const tmp = join(METERS_DIR, `.claude.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(meters) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

/** The status-line command `relay setup` replaced, if it recorded one. */
function previousCommand() {
  if (!existsSync(PREV_PATH)) return undefined;
  try {
    const j = JSON.parse(readFileSync(PREV_PATH, "utf8"));
    return j && typeof j.command === "string" && j.command.trim() ? j.command : undefined;
  } catch {
    return undefined;
  }
}

try {
  main();
} catch {
  /* never break the session */
}
process.exitCode = 0;
