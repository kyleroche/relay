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
/** Set in the image; `relay work` inside reads it to know it is the container worker. */
export const CONTAINER_ENV = "RELAY_ISOLATION";
/** The worker name and host the container worker registers with (set on the container at create time). */
export const CONTAINER_WORKER_NAME_ENV = "RELAY_WORKER_NAME";
export const CONTAINER_WORKER_HOST_ENV = "RELAY_WORKER_HOST";

/** Advertised by the container worker, so the workers page and the flow map show it as a separate machine. */
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
/** Every login callback port the container publishes to the Mac's loopback. */
export const LOGIN_CALLBACK_PORTS = [FX_CALLBACK_PORT, CODEX_CALLBACK_PORT] as const;
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
  logs: (follow: boolean, lines?: number) => string[];
  /** `container exec --user relay …` for any command inside. */
  exec: (argv: string[], interactive?: boolean) => string[];
}

/** The exec prefix every command inside shares: as the relay user, whose home is the volume. */
const execWords = (bin: string, interactive: boolean): string[] => [bin, "exec", "--user", CONTAINER_USER, ...(interactive ? ["-it"] : []), CONTAINER_NAME];

export function containerPlan(s: ContainerSpec): ContainerPlan {
  const exec = (argv: string[], interactive = false) => [...execWords(s.bin, interactive), ...argv];
  const env: Record<string, string> = {
    RELAY_HOME: CONTAINER_RELAY_HOME,
    [CONTAINER_ENV]: "container",
    [CONTAINER_WORKER_NAME_ENV]: s.workerName,
    [CONTAINER_WORKER_HOST_ENV]: s.host,
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
    logs: (follow, lines) => [s.bin, "logs", ...(follow ? ["--follow"] : []), ...(lines ? ["-n", String(lines)] : []), CONTAINER_NAME],
    exec,
  };
}

/** The login commands the operator runs inside after `--install`, in order; printed by the CLI and the docs. */
export const CONTAINER_LOGIN_STEPS: ReadonlyArray<{ cmd: string; why: string }> = [
  { cmd: "relay work container shell", why: "a shell inside the container, as the relay user" },
  { cmd: "claude", why: "then /login: the OAuth paste-code flow (open the URL on this Mac, paste the code back)" },
  { cmd: "gh auth login && gh auth setup-git", why: "the account the worker clones, pushes and opens PRs as" },
  { cmd: "fx login codex", why: "optional: the codex lane" },
  { cmd: "fx login grok", why: "optional: the grok lane" },
  { cmd: "exit", why: "then on the Mac: relay work container status" },
];

/** One container row as `container list --all --format json` prints it; only what the CLI reads. */
export interface ContainerListRow {
  configuration?: { id?: string; image?: { reference?: string } };
  status?: { state?: string; startedDate?: string };
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  state?: string;
  image?: string;
}

/** The state of `relay-work` from the JSON of `container list --all --format json`. */
export function containerStateFrom(listJson: string, name: string = CONTAINER_NAME): ContainerState {
  let rows: ContainerListRow[] = [];
  try {
    const parsed = JSON.parse(listJson) as unknown;
    if (Array.isArray(parsed)) rows = parsed as ContainerListRow[];
  } catch {
    return { exists: false, running: false };
  }
  const row = rows.find((r) => r.configuration?.id === name);
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
