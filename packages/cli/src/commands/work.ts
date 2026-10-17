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
 *
 * Isolation tier 2 (docs/WORKERS.md, "Isolation"): `--isolation container` runs the whole worker inside one
 * persistent Linux container made with Apple's `container` CLI. `--install` builds the image, creates the container
 * with a named volume at /home/relay, runs `relay setup --site` inside (the device flow's code streams to this
 * terminal), prints the login commands and installs a service that keeps the container running.
 * `relay work container shell|status|stop|start|rm|logs` wrap the container commands; `relay work container update`
 * rebuilds the image from this relay and recreates the container on the same volume (the site token and the logins
 * in it are kept, so no new device flow), which is also what `--install --yes` does over an existing container.
 * Inside the container the image
 * sets RELAY_ISOLATION=container and `relay work` adds the labels `isolation:container` and `sandbox:on` or
 * `sandbox:container`, waits for the site and the logins instead of exiting, and names itself `<host>-container`.
 */
import type { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTAINER_CPUS,
  CONTAINER_CREDENTIALS,
  CONTAINER_HOME,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_NAME,
  CONTAINER_PASSTHROUGH_ENV,
  CONTAINER_RELAY_HOME,
  CONTAINER_SANDBOX_LABEL,
  CONTAINER_VOLUME,
  CONTAINER_WORKER_HOST_ENV,
  CONTAINER_WORKER_NAME_ENV,
  containerLoginSteps,
  containerPlan,
  containerSettingsFrom,
  containerStateFrom,
  containerWorkerName,
  imageStatus,
  lanesFromDoctorOutput,
  tokenNameFromDoctorOutput,
  detectGitHub,
  httpWorkApi,
  ISOLATION_LABEL,
  ISOLATIONS,
  laneRunner,
  localWorkApi,
  MAX_IDLE_MS,
  NO_SANDBOX_LABEL,
  POLL_MS,
  readSiteConfig,
  relayHome,
  runtimePaths,
  runWorker,
  SANDBOX_ON_LABEL,
  servicePlan,
  type ContainerPlan,
  type Isolation,
  type WorkApi,
  type WorkerView,
} from "@relay/core";
import { log, onPath, openReady } from "./_common.ts";
import { bwrapProbe, containerReport, detectLanes, inContainer } from "./probes.ts";

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
  isolation?: string;
  site?: string;
  invite?: string;
  memory?: string;
  cpus?: string;
}

/** What the command runs on the machine; tests substitute recorders. */
export interface WorkDeps {
  /** Run and capture (non-interactive). */
  sh: (words: string[], opts?: { timeoutMs?: number }) => { ok: boolean; out: string };
  /** Run with this terminal's stdio (interactive: the device flow, a shell, a long build). Returns the exit code. */
  run: (words: string[], opts?: { cwd?: string }) => number;
  onPath: (bin: string) => string | undefined;
  platform: NodeJS.Platform;
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

/** The `relay work` arguments an install bakes into the service (host) or the container's command. */
export function bakedArgs(o: Pick<WorkOptions, "lanes" | "labels" | "jobs" | "name" | "maxInterval"> & Partial<Pick<WorkOptions, "sandbox">>): string[] {
  const args: string[] = [];
  if (o.lanes) args.push("--lanes", o.lanes);
  if (o.labels) args.push("--labels", o.labels);
  if (o.jobs && o.jobs !== "1") args.push("--jobs", o.jobs);
  if (o.name) args.push("--name", o.name);
  if (o.maxInterval) args.push("--max-interval", o.maxInterval);
  if (o.sandbox === false) args.push("--no-sandbox");
  return args;
}

function plan(o: Pick<WorkOptions, "lanes" | "labels" | "jobs" | "name" | "maxInterval"> & Partial<Pick<WorkOptions, "sandbox">>, deps: WorkDeps, containerBin?: string) {
  const platform = deps.platform === "darwin" ? "darwin" : "linux";
  const rp = runtimePaths();
  // extra hosts for the Claude lane's sandbox travel with the service when set at install time
  const domains = process.env.RELAY_LANE_ALLOWED_DOMAINS;
  return servicePlan({
    platform,
    node: process.execPath,
    cliArgv: rp.cliArgv,
    args: bakedArgs(o),
    home: relayHome(),
    // RELAY_USER_HOME: the same override the hook installers honour, so tests and scripts/check-package.sh write no real LaunchAgent
    userHome: process.env.RELAY_USER_HOME ?? homedir(),
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.getuid ? { uid: process.getuid() } : {}),
    ...(domains ? { env: { RELAY_LANE_ALLOWED_DOMAINS: domains } } : {}),
    ...(containerBin ? { isolation: { kind: "container" as const, bin: containerBin } } : {}),
  });
}

export const defaultDeps: WorkDeps = {
  sh(words, opts) {
    try {
      return { ok: true, out: execFileSync(words[0]!, words.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts?.timeoutMs ?? 30_000 }).trim() };
    } catch (e) {
      // stderr first (the error's first line is what callers quote), then stdout: `relay doctor` inside exits 1 while a
      // login is missing and its report is still wanted
      const err = e as { stderr?: string; stdout?: string; message: string };
      const out = [err.stderr, err.stdout].map((s) => (s ?? "").toString().trim()).filter(Boolean).join("\n");
      return { ok: false, out: out || err.message };
    }
  },
  run(words, opts) {
    const r = spawnSync(words[0]!, words.slice(1), { stdio: "inherit", ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    return r.status ?? (r.error ? 1 : 0);
  },
  onPath,
  platform: process.platform,
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

export function isolationOf(flag: string | undefined): Isolation {
  const v = (flag ?? "host").trim().toLowerCase();
  if (!(ISOLATIONS as readonly string[]).includes(v)) throw new Error(`--isolation: '${flag}' is not one of ${ISOLATIONS.join(", ")}`);
  return v as Isolation;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      res();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Inside the container the process must stay up for `container exec` to reach it, so instead of exiting on "no
 * lanes" the worker waits for the site token (`relay setup --site` inside) and the logins, re-probing every 30 s.
 */
async function waitForReadiness(out: (m: string) => void, forced: string[] | undefined, signal: AbortSignal): Promise<string[]> {
  let said = "";
  for (;;) {
    const site = readSiteConfig();
    const d = forced ? { lanes: forced, reasons: [] as string[] } : await detectLanes();
    const missing: string[] = [];
    if (!site.site || !site.token) missing.push("no site yet: on the Mac run `relay work --isolation container --install`, or inside: relay setup --site <url>");
    if (!d.lanes.length) missing.push(`no lanes yet: ${d.reasons.join("; ")}; log in with: relay work container shell`);
    if (!missing.length) return d.lanes;
    const msg = `waiting: ${missing.join(" | ")}`;
    if (msg !== said) out(msg);
    said = msg;
    await sleep(30_000, signal);
    if (signal.aborted) return [];
  }
}

export function registerWork(program: Command, version: string, deps: WorkDeps = defaultDeps): void {
  const work = program
    .command("work")
    .description("Make this machine a relay worker: claim queued tasks for the lanes its logins allow, run them, open PRs, report usage (docs/WORKERS.md)")
    // `work --yes` is this command's; `work container rm --yes` is the subcommand's (needs the whole chain positional)
    .enablePositionalOptions()
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
    .option("--isolation <tier>", `host (this user, Claude's OS sandbox around the lane) or container (the whole worker in the ${CONTAINER_NAME} container made with Apple's container CLI; the Mac's home is never mounted; docs/WORKERS.md "Isolation")`, "host")
    .option("--site <url>", "container mode: the hosted relay the worker inside joins (default: the site this machine is in)")
    .option("--invite <code>", "container mode: redeem an invite inside instead of the device flow")
    .option("--memory <size>", `container mode: the VM's memory (default ${CONTAINER_MEMORY}; the runtime's 1G default is too little for PGlite)`)
    .option("--cpus <n>", `container mode: the VM's CPUs (default ${CONTAINER_CPUS})`)
    .option("--install", "print the service file that runs `relay work` at login (LaunchAgent on macOS, systemd --user on Linux); --yes writes and starts it. With --isolation container: build the image, create the container, join the site inside, install the service that keeps it running")
    .option("--uninstall", "stop and remove that service (and, with --isolation container, the container; the volume with the logins stays); --yes to do it")
    .option("--yes", "write files and start/stop the service")
    .action(async (o: WorkOptions) => {
      const isolation = isolationOf(o.isolation);
      if (o.install || o.uninstall) return isolation === "container" ? containerInstallOrRemove(o) : installOrRemove(o);
      if (isolation === "container") return containerForeground();
      const lanes = o.lanes ? list(o.lanes) : undefined;
      if (lanes) for (const l of lanes) if (!LANES.includes(l)) throw new Error(`--lanes: '${l}' is not one of ${LANES.join(", ")}`);
      const jobs = Math.max(1, Number(o.jobs) || 1);
      const inside = inContainer();
      const host = (inside ? process.env[CONTAINER_WORKER_HOST_ENV] : undefined) || hostname();
      const name: string = o.name ?? (inside ? process.env[CONTAINER_WORKER_NAME_ENV] || containerWorkerName(host) : host.split(".")[0]!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64));
      const out = fileLog(workLogPath());
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let serving = lanes;
      if (inside) {
        // the container's process must stay alive for `container exec`; wait for the site and the logins instead of exiting
        serving = await waitForReadiness(out, lanes, ac.signal);
        if (ac.signal.aborted) return;
      } else if (!serving) {
        const d = await detectLanes();
        serving = d.lanes;
        if (!serving.length) throw new Error(`no lanes to serve: ${d.reasons.join("; ")}. Log in, or force with --lanes.`);
        if (d.reasons.length) out(`not serving: ${d.reasons.join("; ")}`);
      }
      const pollMs = Math.max(5, Number(o.interval) || POLL_MS / 1000) * 1000;
      const maxIdleMs = maxIntervalMs(o.maxInterval, pollMs);
      const debug = process.env.RELAY_DEBUG ? (m: string) => out(`debug: ${m}`) : undefined;
      const labels = list(o.labels);
      let sandbox = o.sandbox;
      if (inside) {
        if (!labels.includes(ISOLATION_LABEL)) labels.push(ISOLATION_LABEL);
        // the nested sandbox: Claude Code's bubblewrap inside the VM when the runtime lets it start; otherwise the
        // container is the boundary and the label says so (never `sandbox:off`, which means a bare host)
        const probe = sandbox ? await bwrapProbe() : { ok: false, detail: "--no-sandbox" };
        if (!probe.ok) {
          sandbox = false;
          out(`nested sandbox off (${probe.detail}): the Claude lane's Bash runs with the allowlist alone inside this container, which is the boundary; advertised as ${CONTAINER_SANDBOX_LABEL}`);
          if (!labels.includes(CONTAINER_SANDBOX_LABEL)) labels.push(CONTAINER_SANDBOX_LABEL);
        } else if (!labels.includes(SANDBOX_ON_LABEL)) labels.push(SANDBOX_ON_LABEL);
      } else if (!sandbox) {
        // loud on purpose: this machine's Claude jobs run Bash with the rights of this OS user, boxed by the allowlist alone
        out(`WARNING: --no-sandbox: the Claude lane's Bash runs WITHOUT Claude Code's OS sandbox on ${name}. A fooled lane can read this user's files and reach any host; only the tool allowlist stands. Advertised as label ${NO_SANDBOX_LABEL} (docs/SECURITY.md, "Workers").`);
        if (!labels.includes(NO_SANDBOX_LABEL)) labels.push(NO_SANDBOX_LABEL);
      }
      const { api, where, close } = await openWorkApi();
      out(`relay work ${version}: ${name} serving ${serving.join(", ")} via ${where}; jobs=${jobs}, ${o.once ? "once" : `doorbell every ${fmtInterval(pollMs)} to ${fmtInterval(maxIdleMs)} while idle`}, sandbox ${sandbox ? "on" : inside ? "container" : "OFF"}, log ${workLogPath()}`);
      try {
        const r = await runWorker({
          api,
          name,
          host,
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
          job: { timeoutMs: Math.max(1, Number(o.maxMinutes) || 60) * 60_000, ...(o.keep ? { keep: true } : {}), lane: laneRunner({ sandbox }) },
        });
        const held = r.results.filter((x) => x.outcome === "held").length;
        out(`done: ${r.ran} job(s)${r.results.length ? `; ${r.results.filter((x) => x.outcome === "finished").length} finished, ${r.results.filter((x) => x.outcome === "failed").length} failed${held ? `, ${held} held at the gate` : ""}` : ""}`);
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
      const p = plan({ jobs: "1" }, deps);
      const installed = existsSync(p.path);
      const loaded = installed ? deps.sh(p.status).ok : false;
      // the container-mode service runs `container start --attach`; the host-mode one runs relay itself
      const mode = installed && /--attach/.test(readFileSync(p.path, "utf8")) ? "container" : "host";
      const container = deps.platform === "darwin" && !inContainer() && deps.onPath("container") ? await containerReport({ withDoctor: false }) : undefined;
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
        console.log(JSON.stringify({ service: { path: p.path, installed, loaded, mode }, container: container?.container ?? null, where, workers, error: error ?? null, log: logTail }, null, 2));
        return;
      }
      console.log(`service:  ${installed ? (loaded ? "installed and loaded" : "installed, not loaded") : "not installed"}${installed ? ` (${mode} mode)` : ""} (${p.path})`);
      if (container) console.log(`container: ${container.container.exists ? `${CONTAINER_NAME} ${container.container.state ?? "unknown"}${container.container.image ? ` (${container.container.image})` : ""}; relay work container status for the lanes inside` : `no ${CONTAINER_NAME} container (relay work --isolation container --install)`}`);
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

  // ---------- relay work container <shell|status|stop|start|rm|logs> ----------
  const container = work
    .command("container")
    .enablePositionalOptions()
    .description(`The ${CONTAINER_NAME} container (relay work --isolation container): a shell inside, its status, stop/start/rm, logs (docs/WORKERS.md "Isolation")`);
  container
    .command("shell")
    .description(`a shell inside ${CONTAINER_NAME} as the relay user (container exec -it); log in to claude, gh and fx here`)
    .action(() => {
      const c = needContainer();
      process.exitCode = deps.run(c.plan.shell);
    });
  container
    .command("status")
    .description(`whether ${CONTAINER_NAME} exists and runs, then \`relay doctor\` inside and the lanes it would serve`)
    .action(() => {
      const c = needContainer();
      const state = containerStateFrom(deps.sh([c.bin, "list", "--all", "--format", "json"]).out);
      if (!state.exists) return console.log(`container: no ${CONTAINER_NAME} (relay work --isolation container --install)`);
      console.log(`container: ${CONTAINER_NAME} ${state.state ?? "unknown"}`);
      console.log(`image:     ${imageStatus(state.image, `${CONTAINER_IMAGE}:${version}`).line}`);
      if (!state.running) return console.log("start it with: relay work container start");
      // `relay doctor` inside exits 1 while a login is missing; its output is still the report
      const doctor = deps.sh(c.plan.doctor, { timeoutMs: 120_000 }).out;
      if (doctor) console.log(doctor.replace(/^/gm, "  "));
      const lanes = lanesFromDoctorOutput(doctor);
      console.log(lanes === undefined ? "lanes:     unknown (no lanes line from relay doctor inside)" : lanes.length ? `lanes:     ${lanes.join(", ")} (the container worker serves these)` : "lanes:     none yet; log in with: relay work container shell");
    });
  container
    .command("stop")
    .description(`stop ${CONTAINER_NAME} (and unload the service that keeps it running, so it stays stopped)`)
    .action(() => {
      const c = needContainer();
      const p = plan({ jobs: "1" }, deps, c.bin);
      if (existsSync(p.path) && deps.sh(p.status).ok) {
        const r = deps.sh(p.unload[0]!);
        log(`${r.ok ? "unloaded" : "could not unload"} the service (${p.path})`);
      }
      const r = deps.sh(c.plan.stop, { timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`container stop failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`${CONTAINER_NAME} stopped; start again with: relay work container start`);
    });
  container
    .command("start")
    .description(`start ${CONTAINER_NAME}: through the service when it is installed, else detached`)
    .action(() => {
      const c = needContainer();
      const p = plan({ jobs: "1" }, deps, c.bin);
      if (existsSync(p.path)) {
        for (const w of p.load) {
          const r = deps.sh(w);
          if (!r.ok && !/already|in progress|service already loaded/i.test(r.out)) throw new Error(`${w.join(" ")} failed: ${r.out.split("\n")[0] ?? ""}`);
        }
        return log(`service loaded (${p.path}); it runs: ${c.plan.attach.join(" ")}`);
      }
      const r = deps.sh(c.plan.start, { timeoutMs: 120_000 });
      if (!r.ok) throw new Error(`container start failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`${CONTAINER_NAME} started (no service installed; relay work --isolation container --install --yes adds one)`);
    });
  container
    .command("rm")
    .description(`remove ${CONTAINER_NAME} (stops it first); the ${CONTAINER_VOLUME} volume with the logins stays unless --volume`)
    .option("--volume", `also delete the ${CONTAINER_VOLUME} volume: every login inside is gone`)
    .option("--yes", "do it")
    .action((o: { volume?: boolean; yes?: boolean }) => {
      const c = needContainer();
      const words = [c.plan.stop, c.plan.remove, ...(o.volume ? [[c.bin, "volume", "delete", CONTAINER_VOLUME]] : [])];
      for (const w of words) console.log(`would run   ${w.join(" ")}`);
      if (!o.yes) return console.log("\nre-run with --yes to do it");
      for (const w of words) {
        const r = deps.sh(w, { timeoutMs: 60_000 });
        log(`${r.ok ? "ran" : "failed"}: ${w.join(" ")}${r.ok || !r.out ? "" : ` (${r.out.split("\n")[0]})`}`);
      }
    });
  container
    .command("logs")
    .option("-f, --follow", "keep printing")
    .option("-n <lines>", "lines from the end", "50")
    .description(`the worker's output inside ${CONTAINER_NAME} (container logs)`)
    .action((o: { follow?: boolean; n: string }) => {
      const c = needContainer();
      process.exitCode = deps.run(c.plan.logs(!!o.follow, Number(o.n) || undefined));
    });
  container
    .command("update")
    .description(`rebuild the ${CONTAINER_IMAGE} image from this relay and recreate ${CONTAINER_NAME} on it with today's flags; the ${CONTAINER_VOLUME} volume, its site token and its logins stay. Run after git pull or a package upgrade; prints the plan, --yes does it`)
    .option("--site <url>", "the hosted relay to join inside, only when the volume holds no site token (default: the site this machine is in)")
    .option("--invite <code>", "redeem an invite inside instead of the device flow, only when the volume holds no site token")
    .option("--memory <size>", "the VM's memory (default: what the container has now)")
    .option("--cpus <n>", "the VM's CPUs (default: what the container has now)")
    .option("--yes", "rebuild the image and recreate the container")
    .action((o: { site?: string; invite?: string; memory?: string; cpus?: string; yes?: boolean }) => containerInstall({ jobs: "1", interval: String(POLL_MS / 1000), maxMinutes: "60", sandbox: true, ...o }, "update"));

  /** The container CLI, checked, and the plan for this machine (no site needed for the wrappers). */
  function needContainer(): { bin: string; plan: ContainerPlan } {
    const bin = deps.onPath("container");
    if (!bin) throw new Error("Apple's container CLI is not on PATH. Install it from https://github.com/apple/container/releases, then: container system start");
    const host = hostname();
    return { bin, plan: containerPlan({ bin, image: `${CONTAINER_IMAGE}:${version}`, context: join(relayHome(), "container"), site: readSiteConfig().site ?? "", workerName: containerWorkerName(host), host }) };
  }

  /** Foreground container mode: keep this process attached to the container (what the service runs). */
  function containerForeground(): void {
    const c = needContainer();
    const state = containerStateFrom(deps.sh([c.bin, "list", "--all", "--format", "json"]).out);
    if (!state.exists) throw new Error(`no ${CONTAINER_NAME} container; create it with: relay work --isolation container --install --yes`);
    if (state.running) {
      log(`${CONTAINER_NAME} is already running; following its log (Ctrl-C leaves it running)`);
      process.exitCode = deps.run(c.plan.logs(true));
      return;
    }
    process.exitCode = deps.run(c.plan.attach);
  }

  function installOrRemove(o: WorkOptions): void {
    if (o.lanes) for (const l of list(o.lanes)) if (!LANES.includes(l)) throw new Error(`--lanes: '${l}' is not one of ${LANES.join(", ")}`);
    const p = plan(o, deps);
    if (o.uninstall) {
      console.log(`would remove ${p.path}${existsSync(p.path) ? "" : " (not present)"}`);
      for (const w of p.unload) console.log(`would run    ${w.join(" ")}`);
      if (!o.yes) return console.log("\nre-run with --yes to stop the service and remove the file");
      for (const w of p.unload) {
        const r = deps.sh(w);
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
    if (deps.platform === "darwin") console.log("note        a LaunchAgent runs while this user is logged in; enable automatic login or keep a session open on a machine that must stay available");
    if (!o.yes) return console.log("\nre-run with --yes to write the file and start the service");
    mkdirSync(dirname(p.path), { recursive: true });
    mkdirSync(dirname(p.logPath), { recursive: true });
    writeFileSync(p.path, p.content);
    log(`wrote ${p.path}`);
    // a reload: stop the previous registration first so bootstrap does not refuse the duplicate
    if (deps.platform === "darwin") deps.sh(p.unload[0]!);
    for (const w of p.load) {
      const r = deps.sh(w);
      if (!r.ok) throw new Error(`${w.join(" ")} failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`ran ${w.join(" ")}`);
    }
    log(`service running; follow it with: tail -f ${p.logPath}; check with: relay work status`);
  }

  /**
   * `relay work --isolation container --install`: image, volume, container, `relay setup --site` inside, the service.
   * Everything is printed first; --yes does it. `--uninstall` removes the service and the container, never the volume.
   */
  function containerInstallOrRemove(o: WorkOptions): void {
    if (!o.uninstall) return containerInstall(o, "install");
    const { bin, service, stateNow } = containerHost();
    console.log(`would remove ${service.path}${existsSync(service.path) ? "" : " (not present)"}`);
    for (const w of service.unload) console.log(`would run    ${w.join(" ")}`);
    if (stateNow.exists) {
      console.log(`would run    ${bin} stop ${CONTAINER_NAME}`);
      console.log(`would run    ${bin} delete ${CONTAINER_NAME}`);
    } else console.log(`             (no ${CONTAINER_NAME} container)`);
    console.log(`keeps        the ${CONTAINER_VOLUME} volume with the logins inside; delete it with: container volume delete ${CONTAINER_VOLUME}`);
    if (!o.yes) return console.log("\nre-run with --yes to stop the service and remove the container");
    for (const w of service.unload) {
      const r = deps.sh(w);
      log(`${r.ok ? "ran" : "failed"}: ${w.join(" ")}${r.ok || !r.out ? "" : ` (${r.out.split("\n")[0]})`}`);
    }
    if (existsSync(service.path)) {
      rmSync(service.path);
      log(`removed ${service.path}`);
    }
    if (stateNow.exists) {
      for (const w of [[bin, "stop", CONTAINER_NAME], [bin, "delete", CONTAINER_NAME]]) {
        const r = deps.sh(w, { timeoutMs: 60_000 });
        log(`${r.ok ? "ran" : "failed"}: ${w.join(" ")}${r.ok || !r.out ? "" : ` (${r.out.split("\n")[0]})`}`);
      }
    }
    log(`the ${CONTAINER_VOLUME} volume is kept (logins); container volume delete ${CONTAINER_VOLUME} removes it`);
  }

  /** The Mac side of the container tier: the `container` CLI with its services up, the service plan, the container's row. */
  function containerHost() {
    if (inContainer()) throw new Error("already inside the relay container; run this on the Mac");
    const bin = deps.onPath("container");
    if (!bin) throw new Error("Apple's container CLI is not on PATH. Install it from https://github.com/apple/container/releases, then: container system start");
    const sys = deps.sh([bin, "system", "status"]);
    if (!sys.ok || !/^status\s+running/m.test(sys.out)) throw new Error("container services are not running; run: container system start");
    const service = plan({ jobs: "1" }, deps, bin);
    const listJson = deps.sh([bin, "list", "--all", "--format", "json"]).out;
    return { bin, service, listJson, stateNow: containerStateFrom(listJson) };
  }

  /**
   * Inside a running container: is the site token in the volume, and what does `relay doctor` there say about the
   * logins? Both are read-only probes; doctor exits 1 while a login is missing and its report is still the answer.
   */
  function probeInside(c: ContainerPlan): { credentials: boolean; doctor: string } {
    const credentials = deps.sh(c.credentials, { timeoutMs: 60_000 }).ok;
    const doctor = deps.sh(c.doctor, { timeoutMs: 120_000 }).out;
    return { credentials, doctor };
  }

  /** The login sequence for the operator, with the logins the volume already holds marked kept. */
  function printLogins(indent: string, doctorText: string | undefined, intro: string): void {
    const { steps, allKept } = containerLoginSteps(doctorText);
    if (allKept) return console.log(`logins      kept in the volume: ${steps.filter((s) => s.kept).map((s) => s.login).join(", ")} (relay doctor inside)`);
    console.log(intro);
    for (const s of steps) console.log(`${indent}${s.cmd.padEnd(36)} ${s.kept ? "kept (already in the volume)" : s.why}`);
    if (doctorText === undefined) console.log(`${indent}(the logins already in the volume are kept; relay work container status says which)`);
  }

  /**
   * `relay work --isolation container --install` and `relay work container update`, one flow: build the image, keep or
   * create the volume, replace the container, join the site inside only when the volume holds no token, print the
   * logins still to make, install the service. `update` carries the running container's arguments, environment and
   * size over, so a `git pull` or a package upgrade is one command and no new device flow.
   */
  function containerInstall(o: WorkOptions, mode: "install" | "update"): void {
    if (o.lanes) for (const l of list(o.lanes)) if (!LANES.includes(l)) throw new Error(`--lanes: '${l}' is not one of ${LANES.join(", ")}`);
    const { bin, service, listJson, stateNow } = containerHost();
    const host = hostname();
    const rp = runtimePaths();
    const context = join(relayHome(), "container");
    const previous = mode === "update" ? containerSettingsFrom(listJson) : undefined;
    if (mode === "update" && !previous) throw new Error(`no ${CONTAINER_NAME} container to update; create one with: relay work --isolation container --install`);
    const workerName = o.name ?? previous?.workerName ?? containerWorkerName(host);
    const site = o.site ?? readSiteConfig().site;
    if (mode === "install" && !site) throw new Error("container mode joins a hosted relay (the container cannot see this machine's local database): pass --site <url>, or put this machine in site mode first with relay setup --site <url>");
    // the host's passthrough environment, over what the container has now on an update
    const env: Record<string, string> = { ...(previous?.env ?? {}) };
    for (const k of CONTAINER_PASSTHROUGH_ENV) if (process.env[k]) env[k] = process.env[k]!;
    // the inner worker gets its name from the environment; the rest of the arguments ride along (`--no-sandbox` inside
    // means the allowlist alone, advertised as sandbox:container); an update keeps the ones baked in today
    const { name: _name, ...rest } = o;
    void _name;
    const args = previous ? previous.args : bakedArgs(rest);
    const image = `${CONTAINER_IMAGE}:${version}`;
    const cpus = o.cpus === undefined ? previous?.cpus : Number(o.cpus);
    if (cpus !== undefined && (!Number.isInteger(cpus) || cpus < 1)) throw new Error(`--cpus: '${o.cpus}' is not a whole number`);
    const memory = o.memory ?? previous?.memory;
    if (memory !== undefined && !/^\d+[KMGT]?$/i.test(memory)) throw new Error(`--memory: '${o.memory}' is not a size such as 4G or 2048M`);
    const c = containerPlan({
      bin,
      image,
      context,
      ...(rp.layout === "package" ? { relaySpec: `@kyleroche/relay@${version}` } : {}),
      site: site ?? "",
      ...(o.invite ? { invite: o.invite } : {}),
      workerName,
      host: previous?.host ?? host,
      args,
      env,
      ...(memory ? { memory } : {}),
      ...(cpus !== undefined ? { cpus } : {}),
    });
    const volumes = deps.sh([bin, "volume", "list"]).out;
    const haveVolume = new RegExp(`^${CONTAINER_VOLUME}\\b`, "m").test(volumes);
    const serviceInstalled = existsSync(service.path);
    // what the volume holds can be read now only while the container runs; otherwise it is read after the recreate
    const now = stateNow.running ? probeInside(c) : undefined;
    const joinedAs = (doctor: string | undefined) => (doctor && tokenNameFromDoctorOutput(doctor)) ?? `relay-cli@${workerName}`;
    const carried = previous ? [previous.args.length ? previous.args.join(" ") : "", ...Object.keys(previous.env), previous.memory ? `--memory ${previous.memory}` : "", previous.cpus ? `--cpus ${previous.cpus}` : ""].filter(Boolean) : [];

    console.log(`image       ${image}: ${rp.layout === "checkout" ? "relay built from this checkout (pnpm --filter @kyleroche/relay build, npm pack into the context)" : `relay from npm (@kyleroche/relay@${version})`}`);
    console.log(`context     ${context} (Dockerfile and relay-entry from ${rp.containerDir})`);
    console.log(`would run   ${c.build.join(" ")}${stateNow.image ? `  (${CONTAINER_NAME} runs ${stateNow.image}${stateNow.image === image ? ", same tag: the build replaces it" : ""}; the old image stays until the new one is built)` : ""}`);
    console.log(`would run   ${c.volumeCreate.join(" ")}${haveVolume ? "  (exists; kept, with its logins)" : ""}`);
    if (serviceInstalled) console.log(`would run   ${service.unload[0]!.join(" ")}  (the service, so it does not restart the container while it is replaced)`);
    if (stateNow.exists) console.log(`would run   ${c.stop.join(" ")}; ${c.remove.join(" ")}  (recreated from the new image with today's flags; the volume keeps the logins)`);
    console.log(`would run   ${c.create.join(" ")}${carried.length ? `  (carried over: ${carried.join(", ")})` : ""}`);
    console.log(`would run   ${c.start.join(" ")}`);
    console.log(`would run   ${c.credentials.join(" ")}  (a site token in the volume means no device flow)`);
    if (now?.credentials) console.log(`site        joined as ${joinedAs(now.doctor)} (kept: ${CONTAINER_CREDENTIALS} is in the volume)`);
    else if (!site) console.log(`site        none in the volume yet${now ? "" : " as far as this Mac can tell"}: pass --site <url> (or put this Mac in site mode) and relay setup --site runs inside`);
    else console.log(`would run   ${c.setup.join(" ")}  (interactive: the device flow prints its code here${now ? "" : `; skipped when ${CONTAINER_CREDENTIALS} is in the volume`})`);
    console.log(`would run   ${c.stop.join(" ")}  (the service attaches to a stopped container)`);
    console.log(`would write ${service.path}:\n`);
    console.log(service.content.replace(/^/gm, "    "));
    for (const w of service.load) console.log(`would run   ${w.join(" ")}`);
    console.log(`log file    ${service.logPath} (the container's output; inside: ${CONTAINER_NAME}:${CONTAINER_RELAY_HOME}/work.log)`);
    printLogins("              ", now?.doctor, "then        log in inside, in this order:");
    if (deps.platform === "darwin") console.log("note        a LaunchAgent runs while this user is logged in; enable automatic login or keep a session open on a machine that must stay available");
    if (!o.yes) return console.log(`\nre-run with --yes to ${mode === "update" ? "rebuild the image, recreate the container and restart the service" : "build the image, create the container and install the service"}`);

    // 1. the build context: the shipped Dockerfile and entry script, plus this checkout's tarball when relay runs from one
    rmSync(context, { recursive: true, force: true });
    mkdirSync(context, { recursive: true });
    for (const f of ["Dockerfile", "relay-entry"]) copyFileSync(join(rp.containerDir, f), join(context, f));
    if (rp.layout === "checkout") {
      log("building @kyleroche/relay from this checkout for the image…");
      if (deps.run(["pnpm", "--filter", "@kyleroche/relay", "build"], { cwd: rp.root }) !== 0) throw new Error("pnpm --filter @kyleroche/relay build failed");
      if (deps.run(["npm", "pack", "--ignore-scripts", "--pack-destination", context], { cwd: join(rp.root, "packages", "cli") }) !== 0) throw new Error("npm pack failed");
    }
    // 2. the image; the container keeps running on the old one until this succeeds
    log(`building ${image} (a minute or two the first time)…`);
    if (deps.run(c.build) !== 0) throw new Error(`${bin} build failed; ${CONTAINER_NAME} is untouched`);
    // 3. the volume (kept across rebuilds: it holds the logins)
    if (!haveVolume) {
      const r = deps.sh(c.volumeCreate, { timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`${c.volumeCreate.join(" ")} failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`created volume ${CONTAINER_VOLUME}`);
    } else log(`volume ${CONTAINER_VOLUME} exists; kept`);
    // 4. the container, replacing an older one (the service is unloaded first so it does not fight the recreate)
    if (serviceInstalled) deps.sh(service.unload[0]!);
    if (stateNow.exists) {
      deps.sh(c.stop, { timeoutMs: 60_000 });
      const r = deps.sh(c.remove, { timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`${c.remove.join(" ")} failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`removed the previous ${CONTAINER_NAME}${stateNow.image ? ` (${stateNow.image})` : ""}`);
    }
    {
      const r = deps.sh(c.create, { timeoutMs: 120_000 });
      if (!r.ok) throw new Error(`${bin} create failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`created ${CONTAINER_NAME} from ${image} (worker ${workerName}, volume ${CONTAINER_VOLUME} at ${CONTAINER_HOME}, no host mounts)`);
    }
    // 5. start it so exec can reach it; join the site inside only when the volume has no token; read the logins; stop it for the service to attach
    {
      const r = deps.sh(c.start, { timeoutMs: 120_000 });
      if (!r.ok) throw new Error(`${bin} start failed: ${r.out.split("\n")[0] ?? ""}`);
    }
    let after = probeInside(c);
    if (after.credentials) log(`site: joined as ${joinedAs(after.doctor)} (kept)`);
    else if (!site) log(`site: the volume holds no token and no site is known; the worker waits. Join with: relay work container shell, then relay setup --site <url>; or re-run with --site <url>`);
    else {
      log(`joining ${site} from inside the container (approve the code it prints)…`);
      const setupCode = deps.run(c.setup);
      if (setupCode !== 0) log(`relay setup --site inside exited ${setupCode}; the worker waits for it. Retry with: relay work container shell, then relay setup --site ${site}`);
      after = probeInside(c);
    }
    deps.sh(c.stop, { timeoutMs: 60_000 });
    // 6. the service that keeps the container running
    mkdirSync(dirname(service.path), { recursive: true });
    mkdirSync(dirname(service.logPath), { recursive: true });
    writeFileSync(service.path, service.content);
    log(`wrote ${service.path}`);
    for (const w of service.load) {
      const r = deps.sh(w);
      if (!r.ok) throw new Error(`${w.join(" ")} failed: ${r.out.split("\n")[0] ?? ""}`);
      log(`ran ${w.join(" ")}`);
    }
    console.log(`\n${CONTAINER_NAME} is running ${image} as worker ${workerName}.`);
    printLogins("  ", after.doctor, "Log in inside, in this order:\n");
    console.log(`\nThe logins land in the ${CONTAINER_VOLUME} volume, never on this Mac's home. Check with: relay work container status; the worker's log: relay work container logs -f`);
  }
}
