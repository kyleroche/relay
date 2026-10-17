/**
 * Login probes shared by `relay doctor` and `relay work`: which vendor CLIs are on PATH and logged in. Probes print
 * only a derived status, never command output, so no token or account id can leak into a log.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { CONTAINER_NAME, CONTAINER_USER, containerStateFrom, fmtMeterReadings, lanesFromDoctorOutput, METERS_MAX_AGE_MS, readMeterFiles, sandboxPrerequisites, type ContainerState, type HarnessConfig } from "@relay/core";
import { listSiteTools, tokenLabel } from "@relay/mcp";
import { onPath } from "./_common.ts";

export type Status = "ok" | "warn" | "fail";
export interface Check {
  status: Status;
  name: string;
  detail: string;
}

export type ProbeTool = "claude" | "codex" | "fx" | "grok" | "gh";
export const PROBE_TOOLS: readonly ProbeTool[] = ["claude", "codex", "fx", "grok", "gh"];

export function run(bin: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env }, (err, stdout, stderr) =>
      res({ code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** Providers an fx login covers (`connected_providers` in `fx status`), empty when fx is absent or has none. */
export function fxProviders(detail: string): string[] {
  const m = /connected: (.+)$/.exec(detail);
  return m ? m[1]!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}

export async function loginCheck(tool: ProbeTool, bin: string): Promise<Check> {
  const name = `login:${tool}`;
  if (tool === "claude") {
    const r = await run(bin, ["auth", "status", "--json"]);
    try {
      const j = JSON.parse(r.stdout.trim()) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string };
      if (j.loggedIn) return { status: "ok", name, detail: `logged in${j.subscriptionType ? ` (${j.subscriptionType})` : ""}` };
      return { status: "fail", name, detail: "not logged in; run: claude  then /login" };
    } catch {
      return r.code === 0 && /logged in/i.test(r.stdout) && !/not logged in/i.test(r.stdout)
        ? { status: "ok", name, detail: "logged in" }
        : { status: "warn", name, detail: "could not read `claude auth status`; run it yourself" };
    }
  }
  if (tool === "fx") {
    // `fx status` prints `[status] key=value` lines; the ones that matter: connected_providers, auth_expired, auth_refreshable.
    const r = await run(bin, ["status"]);
    const kv = new Map<string, string>();
    for (const m of (r.stdout + "\n" + r.stderr).matchAll(/^\[status\]\s+([a-z_]+)=(.*)$/gim)) kv.set(m[1]!.toLowerCase(), m[2]!.trim());
    if (!kv.size) return { status: "warn", name, detail: "could not read `fx status`; run it yourself" };
    const providers = (kv.get("connected_providers") ?? "").split(",").map((s) => s.trim()).filter((s) => s && !/^none$/i.test(s));
    if (!providers.length) return { status: "fail", name, detail: "no provider login; run: fx login codex | fx login grok" };
    const expired = kv.get("auth_expired") === "true" && kv.get("auth_refreshable") !== "true";
    return expired
      ? { status: "warn", name, detail: `connected: ${providers.join(", ")}; token expired and not refreshable, run: fx login` }
      : { status: "ok", name, detail: `connected: ${providers.join(", ")}` };
  }
  if (tool === "gh") {
    const r = await run(bin, ["auth", "status"]);
    return r.code === 0 ? { status: "ok", name, detail: "logged in" } : { status: "fail", name, detail: "not logged in; run: gh auth login" };
  }
  if (tool === "codex") {
    const r = await run(bin, ["login", "status"]);
    return r.code === 0 && !/not logged in/i.test(r.stdout + r.stderr)
      ? { status: "ok", name, detail: "logged in" }
      : { status: "fail", name, detail: "not logged in; run: codex login" };
  }
  // grok: the CLI has `login` but no status command, so only presence can be verified here.
  return { status: "warn", name, detail: "grok CLI reports no login state; `relay probe grok:<model>` is the real test (run: grok login)" };
}

/** Presence and login checks for every vendor CLI, in doctor's order. */
export async function probeTools(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const tool of PROBE_TOOLS) {
    const bin = onPath(tool);
    if (!bin) {
      checks.push({ status: tool === "gh" || tool === "claude" ? "fail" : "warn", name: `cli:${tool}`, detail: "not on PATH" });
      continue;
    }
    checks.push({ status: "ok", name: `cli:${tool}`, detail: bin });
    checks.push(await loginCheck(tool, bin));
  }
  return checks;
}

/**
 * Can bubblewrap start here? Having `bwrap` on PATH is not enough: a kernel without unprivileged user namespaces, or
 * a container runtime whose masks over /proc forbid a nested procfs mount, make it fail at run time. This is the
 * smallest invocation Claude Code's sandbox needs (a user, pid and mount namespace with /proc mounted inside).
 */
export async function bwrapProbe(): Promise<{ ok: boolean; detail: string }> {
  const r = await run("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], 10_000);
  if (r.code === 0) return { ok: true, detail: "bubblewrap starts" };
  const line = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
  return { ok: false, detail: `bubblewrap cannot start${line ? `: ${line}` : ""}` };
}

/** True inside the relay worker container (the image sets RELAY_ISOLATION; docs/WORKERS.md, "Isolation"). */
export const inContainer = (): boolean => process.env.RELAY_ISOLATION === "container";

/**
 * Can Claude Code sandbox the Claude lane's Bash here? macOS has Seatbelt built in; Linux needs bubblewrap and socat
 * on PATH and a kernel that lets bubblewrap start (`relay work` fails Claude jobs rather than run them unsandboxed,
 * docs/WORKERS.md; inside the relay container it runs them with the allowlist alone and says `sandbox:container`).
 */
export async function sandboxCheck(platform: NodeJS.Platform = process.platform): Promise<Check> {
  const r = sandboxPrerequisites(platform, (bin) => !!onPath(bin));
  if (!r.ok || platform !== "linux") return { status: r.ok ? "ok" : "warn", name: "sandbox", detail: r.detail };
  const probe = await bwrapProbe();
  if (probe.ok) return { status: "ok", name: "sandbox", detail: r.detail };
  const fix = inContainer()
    ? "the container is the boundary: the Claude lane runs with the allowlist alone, advertised as sandbox:container (recreate the container with `relay work --isolation container --install` to get the runtime flags it needs)"
    : "Claude jobs fail here (relay work never runs them unsandboxed); the kernel must allow unprivileged user namespaces";
  return { status: "warn", name: "sandbox", detail: `bubblewrap and socat on PATH but ${probe.detail}; ${fix}` };
}

/** What `relay doctor` on a Mac reports about the container tier (docs/WORKERS.md, "Isolation"). */
export interface ContainerReport {
  bin?: string;
  /** `container system status` says the services run. */
  serviceRunning: boolean;
  container: ContainerState;
  /** The lanes `relay doctor` inside would serve; undefined when the container is not running or doctor gave no lanes line. */
  lanes?: string[];
  /** `relay doctor` inside, verbatim, for `relay work container status`. */
  doctor?: string;
}

export async function containerReport(opts: { withDoctor?: boolean } = {}): Promise<ContainerReport> {
  const bin = onPath("container");
  const out: ContainerReport = { serviceRunning: false, container: { exists: false, running: false } };
  if (!bin) return out;
  out.bin = bin;
  const status = await run(bin, ["system", "status"]);
  out.serviceRunning = status.code === 0 && /^status\s+running/m.test(status.stdout);
  if (!out.serviceRunning) return out;
  const list = await run(bin, ["list", "--all", "--format", "json"]);
  if (list.code === 0) out.container = containerStateFrom(list.stdout, CONTAINER_NAME);
  if (out.container.running && opts.withDoctor !== false) {
    // `relay doctor` inside exits 1 while a login is missing; its output is still the report
    const d = await run(bin, ["exec", "--user", CONTAINER_USER, CONTAINER_NAME, "relay", "doctor"], 120_000);
    out.doctor = (d.stdout + (d.stderr ? `\n${d.stderr}` : "")).trim();
    const lanes = lanesFromDoctorOutput(d.stdout);
    if (lanes) out.lanes = lanes;
  }
  return out;
}

/** The one `container` line of `relay doctor` on the host. */
export function containerCheck(r: ContainerReport): Check {
  const name = "container";
  if (!r.bin) return { status: "warn", name, detail: "Apple's container CLI not on PATH; the container worker tier needs it (https://github.com/apple/container/releases)" };
  if (!r.serviceRunning) return { status: "warn", name, detail: `${r.bin} installed, services not running; run: container system start` };
  if (!r.container.exists) return { status: "ok", name, detail: `installed and running; no ${CONTAINER_NAME} container yet (relay work --isolation container --install)` };
  if (!r.container.running) return { status: "warn", name, detail: `${CONTAINER_NAME} exists (${r.container.state ?? "stopped"}), not running; run: relay work container start` };
  const lanes = r.lanes === undefined ? "lanes unknown (relay doctor inside gave no lanes line)" : r.lanes.length ? `serving ${r.lanes.join(", ")} inside` : "no lanes inside yet (log in: relay work container login all)";
  return { status: "ok", name, detail: `${CONTAINER_NAME} running${r.container.image ? ` (${r.container.image})` : ""}; ${lanes}` };
}

/** "4m", "3h", "2d": the age of a reading for the doctor line. */
function fmtAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The plan meters relay's status line saved under `<home>/meters` (packages/core/src/meters.ts): the values and their
 * age, stale past 48 hours (the worker stops sending them then), or what to do when there is no reading yet.
 */
export function metersCheck(home: string, now: number = Date.now()): Check {
  const name = "meters";
  const all = readMeterFiles(home, { now, maxAgeMs: Number.POSITIVE_INFINITY });
  if (!all.length) return { status: "warn", name, detail: `no reading yet: run an interactive claude session once after relay setup (the status line writes ${join(home, "meters", "claude.json")})` };
  const bySub = new Map<string, typeof all>();
  for (const r of all) bySub.set(r.subscription, [...(bySub.get(r.subscription) ?? []), r]);
  const parts: string[] = [];
  let stale = false;
  for (const [sub, rs] of bySub) {
    const age = now - Date.parse(rs[0]!.captured_at);
    if (age > METERS_MAX_AGE_MS) stale = true;
    parts.push(`${sub}: ${fmtMeterReadings(rs)} (captured ${fmtAge(age)} ago${age > METERS_MAX_AGE_MS ? ", stale: not sent to the site" : ""})`);
  }
  return { status: stale ? "warn" : "ok", name, detail: parts.join("; ") };
}

/**
 * The lanes this machine can serve, from its logins: `claude` when Claude Code is logged in, `codex` when the codex
 * CLI is logged in or fx has a Codex login, `grok` when the grok CLI is present or fx has a Grok login. `gh` must be
 * logged in for any lane (clones, pushes and PRs run as it).
 */
export function lanesFromChecks(checks: Check[]): { lanes: string[]; reasons: string[] } {
  const by = new Map(checks.map((c) => [c.name, c]));
  const reasons: string[] = [];
  const lanes: string[] = [];
  if (by.get("login:gh")?.status !== "ok") {
    reasons.push("gh is not logged in (run: gh auth login); no lane can push without it");
    return { lanes, reasons };
  }
  const fx = fxProviders(by.get("login:fx")?.detail ?? "");
  if (by.get("login:claude")?.status === "ok") lanes.push("claude");
  else reasons.push("claude: not logged in");
  if (by.get("login:codex")?.status === "ok" || fx.includes("codex")) lanes.push("codex");
  else reasons.push("codex: no codex or fx login");
  if (by.get("cli:grok")?.status === "ok" || fx.includes("grok")) lanes.push("grok");
  else reasons.push("grok: no grok CLI or fx login");
  return { lanes, reasons };
}

export const detectLanes = async (): Promise<{ lanes: string[]; reasons: string[] }> => lanesFromChecks(await probeTools());

/**
 * The `mcp` line of `relay doctor`: which mode the installed MCP entry (`relay-mcp`, the stdio server the CLIs'
 * configs point at) runs in. It follows the machine's site/local decision exactly as the CLI does
 * (packages/mcp/src/stdio.ts), so in site mode one `tools/list` against the site with this machine's token is the
 * proof the bridge will answer; in local mode the entry serves the database here.
 */
export async function mcpCheck(cfg: HarnessConfig, opts: { entry: string; listTools?: typeof listSiteTools; now?: () => number }): Promise<Check> {
  const name = "mcp";
  if (!(cfg.site && cfg.siteToken)) return { status: "ok", name, detail: `local mode: ${opts.entry} serves ${cfg.databaseUrl ? "postgres via DATABASE_URL" : `pglite at ${cfg.dbFile}`}` };
  const now = opts.now ?? Date.now;
  const t0 = now();
  const where = `site mode: ${opts.entry} forwards to ${cfg.site} as ${tokenLabel(cfg)}`;
  try {
    const { tools } = await (opts.listTools ?? listSiteTools)({ site: cfg.site, token: cfg.siteToken });
    return { status: "ok", name, detail: `${where}; tools/list answered with ${tools.length} tools, ${now() - t0} ms` };
  } catch (e) {
    return { status: "fail", name, detail: `${where}; tools/list failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
}
