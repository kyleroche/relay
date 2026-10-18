/**
 * Isolation tier 2 for a worker (docs/WORKERS.md, "Isolation"): the whole of `relay work` runs inside one persistent
 * Linux container made with Apple's `container` CLI (each container is its own lightweight VM). The vendor CLIs'
 * logins, the site token, the clones and the model's shell live in a named volume mounted at /home/relay; nothing
 * from the Mac's home directory is mounted. Credentials still never leave the machine: they are created inside the
 * container, on this machine, and stay in its volume.
 *
 * This module is pure: the names, the labels and the shell words `relay work --isolation container` runs, so the
 * tests can check them and the CLI can print the plan before it does anything.
 */

import { fxLoginWords } from "./login.ts";

/** The container `--install` creates; one per machine. */
export const CONTAINER_NAME = "relay-work";
/** The named volume at /home/relay: logins, ~/.harness (site token, work dir, log), the model's shell history. */
export const CONTAINER_VOLUME = "relay-work-home";
/** The image the Dockerfile in `runtimePaths().containerDir` builds; tagged with relay's version. */
export const CONTAINER_IMAGE = "relay-worker";
/** The non-root user inside the image and its home (the volume's mount point). */
export const CONTAINER_USER = "relay";
export const CONTAINER_HOME = "/home/relay";
export const CONTAINER_RELAY_HOME = `${CONTAINER_HOME}/.harness`;
/** The site token `relay setup --site` inside writes; present in the volume means the container has joined already. */
export const CONTAINER_CREDENTIALS = `${CONTAINER_RELAY_HOME}/credentials.json`;
/** Host environment `--install` passes into the container when set, and `update` carries over from the container. */
export const CONTAINER_PASSTHROUGH_ENV = ["RELAY_LANE_ALLOWED_DOMAINS", "RELAY_WORK_MAX_INTERVAL", "RELAY_MODEL_CLAUDE", "RELAY_MODEL_CODEX", "RELAY_MODEL_GROK"] as const;
/** Set in the image; `relay work` inside reads it to know it is the container worker. */
export const CONTAINER_ENV = "RELAY_ISOLATION";
/** The worker name and host the container worker registers with (set on the container at create time). */
export const CONTAINER_WORKER_NAME_ENV = "RELAY_WORKER_NAME";
export const CONTAINER_WORKER_HOST_ENV = "RELAY_WORKER_HOST";

/** Advertised by the container worker, so the workers page and the board show it as a separate machine. */
export const ISOLATION_LABEL = "isolation:container";
/** The Claude lane's Bash runs inside Claude Code's own sandbox, nested in the container. */
export const SANDBOX_ON_LABEL = "sandbox:on";
/**
 * The nested sandbox could not start in this container, so the Claude lane's Bash runs with the allowlist alone
 * and the container is the boundary; said as this label, never as `sandbox:off`.
 */
export const CONTAINER_SANDBOX_LABEL = "sandbox:container";

export type Isolation = "host" | "container";
export const ISOLATIONS: readonly Isolation[] = ["host", "container"];

/** The worker name for the container on a host: `<hostname>-container`. */
export const containerWorkerName = (host: string): string => `${host.split(".")[0]!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 54)}-container`;

export interface ContainerSpec {
  /** The `container` binary (`/usr/local/bin/container`). */
  bin: string;
  /** The image tag to build and run (`relay-worker:0.1.0`). */
  image: string;
  /** The build context: the directory holding the Dockerfile, relay-entry and, from a checkout, the packed tarball. */
  context: string;
  /** `npm install -g` spec for relay when the context has no tarball (the npm package's own version). */
  relaySpec?: string;
  /** The hosted relay the worker inside joins (`relay setup --site`). */
  site: string;
  invite?: string;
  /** The worker's name and the Mac's hostname, both passed into the container as environment. */
  workerName: string;
  host: string;
  /** `relay work` arguments baked into the container's command (`--lanes`, `--labels`, `--jobs`, `--max-interval`). */
  args?: string[];
  /** Extra environment for the worker inside (`RELAY_LANE_ALLOWED_DOMAINS`, `RELAY_WORK_MAX_INTERVAL`). */
  env?: Record<string, string>;
  /** The VM's memory (`container create --memory`); default CONTAINER_MEMORY. The runtime's own default, 1 GB, is too little: PGlite alone reserves about that on first open and the kernel kills the worker. */
  memory?: string;
  /** The VM's CPUs (`--cpus`); default CONTAINER_CPUS. */
  cpus?: number;
}

export const CONTAINER_MEMORY = "4G";
/** The port fx's login flow listens on for the browser redirect (`http://localhost:3000/callback`). */
export const FX_CALLBACK_PORT = 3000;
/** Codex's own OAuth listener, which `fx login codex` hands off to (`http://localhost:1455/auth/callback`). */
export const CODEX_CALLBACK_PORT = 1455;
/**
 * Every login callback port the container publishes to the Mac's loopback. The published port delivers to the
 * container's eth0 address while the login servers bind its loopback, so relay-entry runs one socat per port
 * (eth0 → 127.0.0.1); the list reaches it as LOGIN_PORTS_ENV. Grok's login picks a random port and cannot be
 * published: `relay work container login grok` catches the redirect on the Mac instead and pastes the code to fx
 * (login.ts).
 */
export const LOGIN_CALLBACK_PORTS: readonly number[] = [FX_CALLBACK_PORT, CODEX_CALLBACK_PORT];
export const LOGIN_PORTS_ENV = "RELAY_LOGIN_PORTS";
export const CONTAINER_CPUS = 4;

export interface ContainerPlan {
  build: string[];
  volumeCreate: string[];
  create: string[];
  start: string[];
  /** `container start --attach`: what the service runs; returns when the worker exits. */
  attach: string[];
  stop: string[];
  remove: string[];
  /** Interactive: `relay setup --site` inside, as the relay user; the device flow prints its code to this terminal. */
  setup: string[];
  /** `relay work container shell`. */
  shell: string[];
  /** `relay doctor` inside, non-interactive. */
  doctor: string[];
  /** Exit 0 when the site token is in the volume (`test -f /home/relay/.harness/credentials.json`): no device flow needed. */
  credentials: string[];
  logs: (follow: boolean, lines?: number) => string[];
  /** `container exec --user relay …` for any command inside. */
  exec: (argv: string[], interactive?: boolean) => string[];
  /**
   * `relay work container login` (login.ts): fx with its browser turned off, stdin kept open (`-i`, no TTY) so the
   * Mac side can paste the code; Claude Code and gh as TTY passthroughs; `gh auth setup-git` after gh's login; and a
   * `curl` inside to replay the browser's redirect to a login server on the container's loopback.
   */
  login: {
    fx: (provider: "codex" | "grok") => string[];
    claude: string[];
    gh: string[];
    ghSetupGit: string[];
    replay: (url: string) => string[];
  };
}

/** The exec prefix every command inside shares: as the relay user, whose home is the volume. */
const execWords = (bin: string, interactive: boolean): string[] => [bin, "exec", "--user", CONTAINER_USER, ...(interactive ? ["-it"] : []), CONTAINER_NAME];
/** `-i` alone: stdin stays open for a paste, no TTY, so the output can be read line by line. */
const execStdinWords = (bin: string): string[] => [bin, "exec", "--user", CONTAINER_USER, "-i", CONTAINER_NAME];

export function containerPlan(s: ContainerSpec): ContainerPlan {
  const exec = (argv: string[], interactive = false) => [...execWords(s.bin, interactive), ...argv];
  const env: Record<string, string> = {
    RELAY_HOME: CONTAINER_RELAY_HOME,
    [CONTAINER_ENV]: "container",
    [CONTAINER_WORKER_NAME_ENV]: s.workerName,
    [CONTAINER_WORKER_HOST_ENV]: s.host,
    // relay-entry forwards these from the container's eth0 address to its loopback, where the login servers listen
    [LOGIN_PORTS_ENV]: LOGIN_CALLBACK_PORTS.join(" "),
    ...(s.env ?? {}),
  };
  return {
    build: [s.bin, "build", "--tag", s.image, ...(s.relaySpec ? ["--build-arg", `RELAY_SPEC=${s.relaySpec}`] : []), s.context],
    volumeCreate: [s.bin, "volume", "create", CONTAINER_VOLUME],
    // --masked-path NONE and --read-only-path NONE: the runtime's default masks over /proc and /sys make a nested
    // procfs mount fail inside a user namespace, which is what Claude Code's bubblewrap sandbox needs; the VM is the
    // boundary, so the masks add nothing here. Both flags are marked experimental by `container`; the worker probes
    // bubblewrap at start and falls back to the `sandbox:container` label when it cannot start.
    create: [
      s.bin,
      "create",
      "--name",
      CONTAINER_NAME,
      "--volume",
      `${CONTAINER_VOLUME}:${CONTAINER_HOME}`,
      // fx's OAuth logins (Codex, Grok) redirect the Mac's browser to localhost:3000/callback (Grok) or localhost:1455/auth/callback (Codex); the listener is inside the
      // container, so the port is published to the Mac's loopback only. Claude Code (paste a code) and gh (device code)
      // need no port.
      ...LOGIN_CALLBACK_PORTS.flatMap((port) => ["--publish", `127.0.0.1:${port}:${port}`]),
      "--masked-path",
      "NONE",
      "--read-only-path",
      "NONE",
      "--memory",
      s.memory ?? CONTAINER_MEMORY,
      "--cpus",
      String(s.cpus ?? CONTAINER_CPUS),
      ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      s.image,
      "relay",
      "work",
      ...(s.args ?? []),
    ],
    start: [s.bin, "start", CONTAINER_NAME],
    attach: [s.bin, "start", "--attach", CONTAINER_NAME],
    stop: [s.bin, "stop", CONTAINER_NAME],
    remove: [s.bin, "delete", CONTAINER_NAME],
    setup: exec(["relay", "setup", "--site", s.site, "--name", `relay-cli@${s.workerName}`, ...(s.invite ? ["--invite", s.invite] : [])], true),
    shell: exec(["bash"], true),
    doctor: exec(["relay", "doctor"]),
    credentials: exec(["test", "-f", CONTAINER_CREDENTIALS]),
    logs: (follow, lines) => [s.bin, "logs", ...(follow ? ["--follow"] : []), ...(lines ? ["-n", String(lines)] : []), CONTAINER_NAME],
    exec,
    login: {
      fx: (provider) => [...execStdinWords(s.bin), ...fxLoginWords(provider)],
      claude: exec(["claude"], true),
      gh: exec(["gh", "auth", "login", "--git-protocol", "https", "--web"], true),
      ghSetupGit: exec(["gh", "auth", "setup-git"]),
      replay: (url) => exec(["curl", "-fsS", "-o", "/dev/null", url]),
    },
  };
}

/** The one command that makes every missing login from the Mac (docs/WORKERS.md, "Isolation"; login.ts). */
export const CONTAINER_LOGIN_COMMAND = "relay work container login all";
export const CONTAINER_LOGIN_COMMAND_WHY = "one command; opens this Mac's browser for each login and skips the ones already in the volume (claude, gh, then the optional codex and grok)";

/**
 * The manual fallback: the login commands the operator runs inside, in order; printed under CONTAINER_LOGIN_COMMAND
 * by the CLI and the docs. `login` names the login the step makes, so `update` can mark the ones the volume already
 * holds as kept.
 */
export const CONTAINER_LOGIN_STEPS: ReadonlyArray<{ cmd: string; why: string; login?: keyof LoginStates }> = [
  { cmd: "relay work container shell", why: "a shell inside the container, as the relay user" },
  { cmd: "claude", why: "then /login: the OAuth paste-code flow (open the URL on this Mac, paste the code back, /exit)", login: "claude" },
  { cmd: "gh auth login && gh auth setup-git", why: "the account the worker clones, pushes and opens PRs as (device code)", login: "gh" },
  { cmd: "fx login codex", why: "optional: the codex lane (the browser's redirect to localhost:1455 reaches the container through the published port)", login: "codex" },
  {
    cmd: "FX_NO_OPEN_BROWSER=1 fx login grok",
    why: "optional: the grok lane; open the printed URL on this Mac, and when the browser ends on an unreachable 127.0.0.1:<port>/callback?…&code=… page, paste only the code value into fx's prompt",
    login: "grok",
  },
  { cmd: "exit", why: "then on the Mac: relay work container status" },
];

/** Which logins `relay doctor` inside reports as present (the volume holds them). */
export interface LoginStates {
  claude: boolean;
  gh: boolean;
  /** The codex CLI's login, or an fx Codex login. */
  codex: boolean;
  /** The grok CLI, or an fx Grok login. */
  grok: boolean;
}

/** One `<status> <name> <detail>` line of `relay doctor`. */
function doctorLine(text: string, name: string): { status: string; detail: string } | undefined {
  const m = new RegExp(`^(ok|warn|fail)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.*)$`, "m").exec(text);
  return m ? { status: m[1]!, detail: m[2]!.trim() } : undefined;
}

/**
 * The logins `relay doctor` (inside the container) reports. An fx line that is `warn` (token expired and not
 * refreshable) counts as missing, since its lanes would fail.
 */
export function loginStatesFromDoctorOutput(text: string): LoginStates {
  const fxLine = doctorLine(text, "login:fx");
  const fx = fxLine?.status === "ok" ? (/connected: (.+)$/.exec(fxLine.detail)?.[1] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return {
    claude: doctorLine(text, "login:claude")?.status === "ok",
    gh: doctorLine(text, "login:gh")?.status === "ok",
    codex: doctorLine(text, "login:codex")?.status === "ok" || fx.includes("codex"),
    grok: doctorLine(text, "cli:grok")?.status === "ok" || fx.includes("grok"),
  };
}

/** The token's name from doctor's `auth` line inside (`… as oauth:relay-cli@mac-container, expires …`). */
export function tokenNameFromDoctorOutput(text: string): string | undefined {
  const line = doctorLine(text, "auth");
  const m = line ? /\bas (\S+?),?(?:\s|$)/.exec(line.detail) : null;
  return m?.[1];
}

export interface LoginStep {
  cmd: string;
  why: string;
  /** The login the step makes; absent on the shell and exit lines. */
  login?: keyof LoginStates;
  /** true: this login is in the volume; false: missing; undefined: not a login (the shell and exit lines), or unknown. */
  kept?: boolean;
}

/**
 * The login sequence with what the volume already holds marked `kept`, from `relay doctor` output inside; without it
 * (the container is not running yet) every step is an instruction. `allKept` means one summary line can replace the list.
 */
export function containerLoginSteps(doctorText?: string): { steps: LoginStep[]; allKept: boolean } {
  const states = doctorText === undefined ? undefined : loginStatesFromDoctorOutput(doctorText);
  const steps: LoginStep[] = CONTAINER_LOGIN_STEPS.map(({ cmd, why, login }) => ({ cmd, why, ...(login ? { login } : {}), ...(login && states ? { kept: states[login] } : {}) }));
  return { steps, allKept: !!states && steps.every((s) => s.kept !== false) };
}

/**
 * What `--install` chose for the container and `update` keeps: the `relay work` arguments baked into its command, the
 * passthrough environment, the worker's name and host, the VM's size. From the row of `container list --all --format
 * json`; undefined when the container is not there.
 */
export interface ContainerSettings {
  /** The arguments after `relay work` (`--lanes claude --jobs 2`). */
  args: string[];
  /** Only the CONTAINER_PASSTHROUGH_ENV keys; the image's own variables and relay's fixed ones are not settings. */
  env: Record<string, string>;
  workerName?: string;
  host?: string;
  /** As `--memory` spells it (`4G`, `2048M`). */
  memory?: string;
  cpus?: number;
}

/** Bytes as the size `--memory` takes: whole gigabytes, else megabytes, else kilobytes, else bytes. */
export function fmtMemory(bytes: number): string {
  for (const [unit, size] of [
    ["G", 2 ** 30],
    ["M", 2 ** 20],
    ["K", 2 ** 10],
  ] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return String(bytes);
}

export function containerSettingsFrom(listJson: string, name: string = CONTAINER_NAME): ContainerSettings | undefined {
  const row = listRow(listJson, name);
  if (!row) return undefined;
  const argv = row.configuration?.initProcess?.arguments ?? [];
  const out: ContainerSettings = { args: argv[0] === "relay" && argv[1] === "work" ? argv.slice(2) : [], env: {} };
  for (const kv of row.configuration?.initProcess?.environment ?? []) {
    const eq = kv.indexOf("=");
    if (eq < 0) continue;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    if ((CONTAINER_PASSTHROUGH_ENV as readonly string[]).includes(k)) out.env[k] = v;
    else if (k === CONTAINER_WORKER_NAME_ENV && v) out.workerName = v;
    else if (k === CONTAINER_WORKER_HOST_ENV && v) out.host = v;
  }
  const res = row.configuration?.resources;
  if (res?.memoryInBytes && res.memoryInBytes > 0) out.memory = fmtMemory(res.memoryInBytes);
  if (res?.cpus && res.cpus > 0) out.cpus = res.cpus;
  return out;
}

/** `relay work container status`: does the container run the image this relay would build? */
export function imageStatus(running: string | undefined, current: string): { current: boolean; line: string } {
  if (!running) return { current: false, line: `unknown (no image reference from container list); rebuild with relay work container update` };
  if (running === current) return { current: true, line: `${running} (this relay's build)` };
  return { current: false, line: `${running}; this relay would build ${current}: rebuild with relay work container update` };
}

/** One container row as `container list --all --format json` prints it; only what the CLI reads. */
export interface ContainerListRow {
  configuration?: {
    id?: string;
    image?: { reference?: string };
    /** The command the container was created with (`relay work …`, after the image's entry point) and its `--env` list. */
    initProcess?: { arguments?: string[]; environment?: string[] };
    resources?: { cpus?: number; memoryInBytes?: number };
  };
  status?: { state?: string; startedDate?: string };
}

function listRow(listJson: string, name: string): ContainerListRow | undefined {
  try {
    const parsed = JSON.parse(listJson) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return (parsed as ContainerListRow[]).find((r) => r.configuration?.id === name);
  } catch {
    return undefined;
  }
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  state?: string;
  image?: string;
}

/** The state of `relay-work` from the JSON of `container list --all --format json`. */
export function containerStateFrom(listJson: string, name: string = CONTAINER_NAME): ContainerState {
  const row = listRow(listJson, name);
  if (!row) return { exists: false, running: false };
  const state = row.status?.state ?? "unknown";
  const out: ContainerState = { exists: true, running: state === "running", state };
  if (row.configuration?.image?.reference) out.image = row.configuration.image.reference;
  return out;
}

/** The `lanes` line of `relay doctor` output → the lanes it would serve (empty when none, or the line is missing). */
export function lanesFromDoctorOutput(text: string): string[] | undefined {
  const m = /^\S+\s+lanes\s+(.+)$/m.exec(text);
  if (!m) return undefined;
  const detail = m[1]!.trim();
  if (detail.startsWith("none")) return [];
  return detail
    .split(" (")[0]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
