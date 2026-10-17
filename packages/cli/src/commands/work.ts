/**
 * `relay work`: this machine becomes a worker (docs/WORKERS.md). It registers with the lanes its logins allow, reads
 * the queue's doorbell on a tick that stretches from 15 s to 5 min while nothing is queued, claims the oldest queued
 * task it can run, runs it with the vendor CLI under the machine's own login, opens the PR and reports usage. In site mode (`relay setup --site`) everything goes through the
 * hosted relay; without a site it schedules against the local database.
 *
 *   relay work                 foreground loop; logs to $RELAY_HOME/work.log
 *   relay work --once          drain the queue once and exit
 *   relay work --install       print the LaunchAgent (macOS) or systemd user unit (Linux); --yes writes and starts it
 *   relay work --uninstall     stop and remove the service; --yes to do it
 *   relay work status          the service, this site's workers, the log tail
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { detectGitHub, httpWorkApi, laneRunner, localWorkApi, MAX_IDLE_MS, NO_SANDBOX_LABEL, POLL_MS, relayHome, runtimePaths, runWorker, servicePlan, type WorkApi, type WorkerView } from "@relay/core";
import { log, openReady } from "./_common.ts";
import { detectLanes } from "./probes.ts";

interface WorkOptions {
  once?: boolean;
  lanes?: string;
  labels?: string;
  jobs: string;
  name?: string;
  interval: string;
  maxInterval?: string;
  maxMinutes: string;
  keep?: boolean;
  /** commander's `--no-sandbox`: true unless the flag was passed. */
  sandbox: boolean;
  install?: boolean;
  uninstall?: boolean;
  yes?: boolean;
}

const LANES = ["claude", "codex", "grok"];
const list = (s: string | undefined): string[] => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
export const workLogPath = (): string => join(relayHome(), "work.log");

function fileLog(path: string): (m: string) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (m: string) => {
    const line = `${new Date().toISOString()} ${m}`;
    console.error(`[relay work] ${m}`);
    try {
      appendFileSync(path, line + "\n");
    } catch {
      /* unwritable home: stderr still has it */
    }
  };
}

/** Site mode talks to the hosted relay; local mode schedules against this machine's database. */
async function openWorkApi(): Promise<{ api: WorkApi; where: string; close: () => Promise<void> }> {
  const h = await openReady();
  if (h.mode === "site") return { api: httpWorkApi({ site: h.cfg.site!, token: h.cfg.siteToken! }), where: h.cfg.site!, close: () => h.close() };
  return { api: localWorkApi(h.db, { github: detectGitHub() }), where: h.db.driver === "pg" ? "postgres via DATABASE_URL" : `pglite at ${h.cfg.dbFile}`, close: () => h.close() };
}

function plan(o: Pick<WorkOptions, "lanes" | "labels" | "jobs" | "name" | "maxInterval"> & Partial<Pick<WorkOptions, "sandbox">>) {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const args: string[] = [];
  if (o.lanes) args.push("--lanes", o.lanes);
  if (o.labels) args.push("--labels", o.labels);
  if (o.jobs && o.jobs !== "1") args.push("--jobs", o.jobs);
  if (o.name) args.push("--name", o.name);
  if (o.maxInterval) args.push("--max-interval", o.maxInterval);
  if (o.sandbox === false) args.push("--no-sandbox");
  const rp = runtimePaths();
  // extra hosts for the Claude lane's sandbox travel with the service when set at install time
  const domains = process.env.RELAY_LANE_ALLOWED_DOMAINS;
  return servicePlan({ platform, node: process.execPath, cliArgv: rp.cliArgv, args, home: relayHome(), userHome: homedir(), path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(process.getuid ? { uid: process.getuid() } : {}), ...(domains ? { env: { RELAY_LANE_ALLOWED_DOMAINS: domains } } : {}) });
}

const sh = (words: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync(words[0]!, words.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim() };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: (err.stderr || err.stdout || err.message).toString().trim() };
  }
};

const fmtInterval = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 1000)}s`);

function fmtWorker(w: WorkerView, now: number): string {
  const ago = Math.max(0, Math.round((now - new Date(w.last_seen).getTime()) / 1000));
  const seen = ago < 90 ? `${ago}s ago` : ago < 5400 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;
  const cur = w.current ? `  on ${w.current.task_id} since ${w.current.claimed_at.slice(11, 16)}Z` : "";
  const every = w.poll_ms && w.state !== "offline" ? `  every ${fmtInterval(w.poll_ms)}` : "";
  return `${w.name.padEnd(14)} ${w.state.padEnd(8)} ${(w.lanes.join(",") || "-").padEnd(18)} ${w.version.padEnd(8)} seen ${seen}${every}${w.labels.length ? `  [${w.labels.join(",")}]` : ""}${cur}`;
}

/** `--max-interval`, else RELAY_WORK_MAX_INTERVAL, else 5 minutes; never below the first tick. */
function maxIntervalMs(flag: string | undefined, pollMs: number): number {
  const raw = flag ?? process.env.RELAY_WORK_MAX_INTERVAL;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (raw !== undefined && raw !== "" && (!Number.isFinite(n) || n <= 0)) throw new Error(`--max-interval: '${raw}' is not a number of seconds`);
  return Math.max(pollMs, Number.isFinite(n) ? n * 1000 : MAX_IDLE_MS);
}

export function registerWork(program: Command, version: string): void {
  const work = program
    .command("work")
    .description("Make this machine a relay worker: claim queued tasks for the lanes its logins allow, run them, open PRs, report usage (docs/WORKERS.md)")
    .option("--once", "drain the queue once, then exit")
    .option("--lanes <list>", "force the lanes to serve (default: detected from logins), e.g. claude,codex")
    .option("--labels <list>", "capabilities this worker advertises, matched against a project's lane.labels preference, e.g. gpu,xcode")
    .option("--jobs <n>", "concurrent jobs (the lanes still serialize per vendor login)", "1")
    .option("--name <name>", "worker name (default: this host's short name)")
    .option("--interval <seconds>", "the first tick after activity; the loop doubles it while nothing is queued", String(POLL_MS / 1000))
    .option("--max-interval <seconds>", `the longest tick while idle (default ${MAX_IDLE_MS / 1000}, or RELAY_WORK_MAX_INTERVAL); set it above your database's auto-suspend timeout to let it sleep`)
    .option("--max-minutes <n>", "time limit per run", "60")
    .option("--keep", "keep each clone under $RELAY_HOME/work after the run")
    .option("--no-sandbox", `run the Claude lane's Bash without Claude Code's OS sandbox (allowlist only); logged, and advertised as the label ${NO_SANDBOX_LABEL}`)
    .option("--install", "print the service file that runs `relay work` at login (LaunchAgent on macOS, systemd --user on Linux); --yes writes and starts it")
    .option("--uninstall", "stop and remove that service; --yes to do it")
    .option("--yes", "write files and start/stop the service")
    .action(async (o: WorkOptions) => {
      if (o.install || o.uninstall) return installOrRemove(o);
      const lanes = o.lanes ? list(o.lanes) : undefined;
      if (lanes) for (const l of lanes) if (!LANES.includes(l)) throw new Error(`--lanes: '${l}' is not one of ${LANES.join(", ")}`);
      const jobs = Math.max(1, Number(o.jobs) || 1);
      const name = o.name ?? hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64);
      const out = fileLog(workLogPath());
      let serving = lanes;
      if (!serving) {
        const d = await detectLanes();
        serving = d.lanes;
        if (!serving.length) throw new Error(`no lanes to serve: ${d.reasons.join("; ")}. Log in, or force with --lanes.`);
        if (d.reasons.length) out(`not serving: ${d.reasons.join("; ")}`);
      }
      const pollMs = Math.max(5, Number(o.interval) || POLL_MS / 1000) * 1000;
      const maxIdleMs = maxIntervalMs(o.maxInterval, pollMs);
      const debug = process.env.RELAY_DEBUG ? (m: string) => out(`debug: ${m}`) : undefined;
      const labels = list(o.labels);
      if (!o.sandbox) {
        // loud on purpose: this machine's Claude jobs run Bash with the rights of this OS user, boxed by the allowlist alone
        out(`WARNING: --no-sandbox: the Claude lane's Bash runs WITHOUT Claude Code's OS sandbox on ${name}. A fooled lane can read this user's files and reach any host; only the tool allowlist stands. Advertised as label ${NO_SANDBOX_LABEL} (docs/SECURITY.md, "Workers").`);
        if (!labels.includes(NO_SANDBOX_LABEL)) labels.push(NO_SANDBOX_LABEL);
      }
      const { api, where, close } = await openWorkApi();
      out(`relay work ${version}: ${name} serving ${serving.join(", ")} via ${where}; jobs=${jobs}, ${o.once ? "once" : `doorbell every ${fmtInterval(pollMs)} to ${fmtInterval(maxIdleMs)} while idle`}, sandbox ${o.sandbox ? "on" : "OFF"}, log ${workLogPath()}`);
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const r = await runWorker({
          api,
          name,
          host: hostname(),
          lanes: serving,
          labels,
          version,
          jobs,
          ...(o.once ? { once: true } : {}),
          pollMs,
          maxIdleMs,
          log: out,
          ...(debug ? { debug } : {}),
          signal: ac.signal,
          job: { timeoutMs: Math.max(1, Number(o.maxMinutes) || 60) * 60_000, ...(o.keep ? { keep: true } : {}), lane: laneRunner({ sandbox: o.sandbox }) },
        });
        out(`done: ${r.ran} job(s)${r.results.length ? `; ${r.results.filter((x) => x.outcome === "finished").length} finished, ${r.results.filter((x) => x.outcome === "failed").length} failed` : ""}`);
        if (r.results.some((x) => x.outcome === "failed")) process.exitCode = 1;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await close();
      }
    });

  work
    .command("status")
    .option("--json")
    .description("The service on this machine, the workers the site knows, and the last lines of work.log")
    .action(async (o: { json?: boolean }) => {
      const p = plan({ jobs: "1" });
      const installed = existsSync(p.path);
      const loaded = installed ? sh(p.status).ok : false;
      const { api, where, close } = await openWorkApi();
      let workers: WorkerView[] = [];
      let error: string | undefined;
      try {
        workers = await api.workers();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        await close();
      }
      const logTail = existsSync(p.logPath) ? readFileSync(p.logPath, "utf8").trimEnd().split("\n").slice(-10) : [];
      if (o.json) {
        console.log(JSON.stringify({ service: { path: p.path, installed, loaded }, where, workers, error: error ?? null, log: logTail }, null, 2));
        return;
      }
      console.log(`service:  ${installed ? (loaded ? "installed and loaded" : "installed, not loaded") : "not installed"} (${p.path})`);
      console.log(`backend:  ${where}`);
      if (error) console.log(`workers:  unavailable (${error})`);
      else if (!workers.length) console.log("workers:  none registered yet; run `relay work` or `relay work --install --yes`");
      else {
        const now = Date.now();
        console.log("workers:");
        for (const w of workers) console.log(`  ${fmtWorker(w, now)}`);
      }
      if (logTail.length) {
        console.log(`log:      ${p.logPath}`);
        for (const l of logTail) console.log(`  ${l}`);
      }
    });

  function installOrRemove(o: WorkOptions): void {
    if (o.lanes) for (const l of list(o.lanes)) if (!LANES.includes(l)) throw new Error(`--lanes: '${l}' is not one of ${LANES.join(", ")}`);
    const p = plan(o);
    if (o.uninstall) {
      console.log(`would remove ${p.path}${existsSync(p.path) ? "" : " (not present)"}`);
      for (const w of p.unload) console.log(`would run    ${w.join(" ")}`);
      if (!o.yes) return console.log("\nre-run with --yes to stop the service and remove the file");
      for (const w of p.unload) {
        const r = sh(w);
        log(`${r.ok ? "ran" : "failed"}: ${w.join(" ")}${r.ok || !r.out ? "" : ` (${r.out.split("\n")[0]})`}`);
      }
      if (existsSync(p.path)) rmSync(p.path);
      log(`removed ${p.path}`);
      return;
    }
    console.log(`would write ${p.path}:\n`);
    console.log(p.content.replace(/^/gm, "    "));
    if (o.sandbox === false) console.log(`WARNING     the service will run the Claude lane's Bash without Claude Code's OS sandbox (--no-sandbox is baked in; label ${NO_SANDBOX_LABEL})`);
    for (const w of p.load) console.log(`would run   ${w.join(" ")}`);
    console.log(`log file    ${p.logPath}`);
    if (process.platform === "darwin") console.log("note        a LaunchAgent runs while this user is logged in; enable automatic login or keep a session open on a machine that must stay available");
    if (!o.yes) return console.log("\nre-run with --yes to write the file and start the service");
    mkdirSync(dirname(p.path), { recursive: true });
    mkdirSync(dirname(p.logPath), { recursive: true });
    writeFileSync(p.path, p.content);
    log(`wrote ${p.path}`);
    // a reload: stop the previous registration first so bootstrap does not refuse the duplicate
    if (process.platform === "darwin") sh(p.unload[0]!);
    for (const w of p.load) {
      const r = sh(w);
      if (!r.ok) throw new Error(`${w.join(" ")} failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`ran ${w.join(" ")}`);
    }
    log(`service running; follow it with: tail -f ${p.logPath}; check with: relay work status`);
  }
}
