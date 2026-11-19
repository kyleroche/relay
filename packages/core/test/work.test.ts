/**
 * What a worker machine is made of (docs/WORKERS.md): the state a worker's row reads as, `claimed` in the task fold,
 * the service files, the container plan and the container login helpers.
 */
import { describe, it, expect } from "vitest";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus, type ClaimLike } from "../src/db/tasks.ts";
import { servicePlan } from "../src/work/service.ts";
import { fxLoginWords, isLoginProvider, LOGIN_PROVIDERS, loginDonePage, manualLoginSteps, OAUTH_PROVIDERS, parseLoginCallback, parseLoginUrl, replayUrl } from "../src/work/login.ts";
import {
  CONTAINER_LOGIN_COMMAND,
  CONTAINER_LOGIN_STEPS,
  CONTAINER_NAME,
  CONTAINER_VOLUME,
  containerLoginSteps,
  containerPlan,
  containerSettingsFrom,
  containerStateFrom,
  containerWorkerName,
  fmtMemory,
  imageStatus,
  lanesFromDoctorOutput,
  loginStatesFromDoctorOutput,
  tokenNameFromDoctorOutput,
} from "../src/work/container.ts";

describe("workers", () => {
  it("derives online, idle and offline from last_seen", () => {
    const now = Date.now();
    expect(repo.workerState({ last_seen: new Date(now - 30_000).toISOString(), status: "online" }, now)).toBe("online");
    expect(repo.workerState({ last_seen: new Date(now - 10 * 60_000).toISOString(), status: "online" }, now)).toBe("idle");
    expect(repo.workerState({ last_seen: new Date(now - 2 * 3_600_000).toISOString(), status: "online" }, now)).toBe("offline");
    expect(repo.workerState({ last_seen: new Date(now).toISOString(), status: "offline" }, now)).toBe("offline");
  });

  it("marks a worker offline for more than 7 days as retired; a fresh offline report is not retired", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const day = 24 * 60 * 60_000;
    expect(repo.workerRetired({ last_seen: new Date(now - 8 * day).toISOString(), status: "online" }, now)).toBe(true);
    expect(repo.workerRetired({ last_seen: new Date(now - 8 * day).toISOString(), status: "offline" }, now)).toBe(true);
    expect(repo.workerRetired({ last_seen: new Date(now - 3 * day).toISOString(), status: "offline" }, now)).toBe(false);
    expect(repo.workerRetired({ last_seen: new Date(now - 60_000).toISOString(), status: "offline" }, now)).toBe(false);
    expect(repo.workerRetired({ last_seen: new Date(now - 8 * day).toISOString(), status: "online" }, now - 8 * day + 1000)).toBe(false);
  });
});

describe("deriveTaskStatus with claims", () => {
  const task = { repo: "acme/demo", issue: 1 };
  const ev = (kind: string, ts: string, extra: Partial<repo.EventRow> = {}): repo.EventRow => ({ id: 0, ts, kind, actor: "runner:mini", project: "demo", repo: "acme/demo", issue: 1, pr: null, lane: "claude", model: null, subscription: null, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_equiv: 0, duration_ms: null, summary: kind, url: null, payload: {}, dedupe_key: null, ...extra });
  const now = Date.parse("2026-10-16T10:30:00Z");
  const claim = (over: Partial<ClaimLike> = {}): ClaimLike => ({ worker: "mini", claimed_at: "2026-10-16T10:00:00.000Z", lease_until: "2026-10-16T11:00:00.000Z", released_at: null, outcome: null, ...over });

  it("a live lease on a queued task is `claimed`", () => {
    const s = deriveTaskStatus(task, [], [claim()], now);
    expect(s.state).toBe("claimed");
    expect(s.runner).toBe("runner:mini");
  });
  it("run.started under a live lease is running; a finished run is review regardless of the lease", () => {
    expect(deriveTaskStatus(task, [ev("run.started", "2026-10-16T10:05:00.000Z")], [claim()], now).state).toBe("running");
    expect(deriveTaskStatus(task, [ev("run.started", "2026-10-16T10:05:00.000Z"), ev("run.finished", "2026-10-16T10:20:00.000Z", { payload: { conclusion: "success" } })], [claim({ released_at: "2026-10-16T10:20:00.000Z", outcome: "finished" })], now).state).toBe("review");
  });
  it("a lease that expired mid-run puts the task back to queued; an expired lease before any run is plain queued", () => {
    const expired = claim({ released_at: "2026-10-16T10:29:00.000Z", outcome: "expired" });
    expect(deriveTaskStatus(task, [ev("run.started", "2026-10-16T10:05:00.000Z")], [expired], now).state).toBe("queued");
    expect(deriveTaskStatus(task, [], [expired], now).state).toBe("queued");
    // a lease past its time that nobody marked yet is not live either
    expect(deriveTaskStatus(task, [], [claim({ lease_until: "2026-10-16T10:10:00.000Z" })], now).state).toBe("queued");
  });
});

describe("service files", () => {
  const base = { node: "/opt/node/bin/node", cliArgv: ["/usr/lib/relay/dist/relay.js"], home: "/Users/relay/.harness", userHome: "/Users/relay", path: "/opt/node/bin:/usr/bin:/bin", uid: 502 } as const;
  it("macOS: a LaunchAgent in the user's context with the log under RELAY_HOME", () => {
    const p = servicePlan({ ...base, platform: "darwin", args: ["--lanes", "claude,codex"] });
    expect(p.path).toBe("/Users/relay/Library/LaunchAgents/house.kyro.relay.work.plist");
    expect(p.content).toContain("<string>/opt/node/bin/node</string>");
    expect(p.content).toContain("<string>/usr/lib/relay/dist/relay.js</string>");
    expect(p.content).toContain("<string>work</string>");
    expect(p.content).toContain("<string>claude,codex</string>");
    expect(p.content).toContain("<key>KeepAlive</key><true/>");
    expect(p.content).toContain("<key>StandardOutPath</key><string>/Users/relay/.harness/work.log</string>");
    expect(p.content).toContain("<key>RELAY_HOME</key><string>/Users/relay/.harness</string>");
    expect(p.load).toEqual([["launchctl", "bootstrap", "gui/502", p.path]]);
    expect(p.unload[0]).toEqual(["launchctl", "bootout", "gui/502/house.kyro.relay.work"]);
  });
  it("Linux: a systemd user unit that restarts and appends to the log", () => {
    const p = servicePlan({ ...base, platform: "linux", userHome: "/home/relay", home: "/home/relay/.harness" });
    expect(p.path).toBe("/home/relay/.config/systemd/user/relay-work.service");
    expect(p.content).toContain("ExecStart=/opt/node/bin/node /usr/lib/relay/dist/relay.js work");
    expect(p.content).toContain("Restart=always");
    expect(p.content).toContain("StandardOutput=append:/home/relay/.harness/work.log");
    expect(p.content).toContain("Environment=PATH=/opt/node/bin:/usr/bin:/bin");
    expect(p.content).toContain("Environment=RELAY_HOME=/home/relay/.harness");
    expect(p.load.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "relay-work.service"]);
  });
  it("container mode, macOS: the LaunchAgent keeps `container start --attach relay-work` alive and runs no relay itself", () => {
    const p = servicePlan({ ...base, platform: "darwin", args: ["--lanes", "claude"], isolation: { kind: "container", bin: "/usr/local/bin/container" } });
    expect(p.path).toBe("/Users/relay/Library/LaunchAgents/house.kyro.relay.work.plist");
    const argv = [...p.content.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(argv.slice(1, 5)).toEqual(["/usr/local/bin/container", "start", "--attach", "relay-work"]);
    expect(p.content).not.toContain("/opt/node/bin/node");
    expect(p.content).not.toContain("<string>work</string>");
    expect(p.content).not.toContain("claude"); // the worker's arguments live in the container, not the service
    expect(p.content).toContain("<key>KeepAlive</key><true/>");
    expect(p.content).toContain("<key>HOME</key><string>/Users/relay</string>");
    expect(p.content).not.toContain("RELAY_HOME"); // the container has its own
    expect(p.content).toContain("<key>StandardOutPath</key><string>/Users/relay/.harness/work.log</string>");
    expect(p.load).toEqual([["launchctl", "bootstrap", "gui/502", p.path]]);
  });
  it("container mode, Linux: the unit's ExecStart is the container command", () => {
    const p = servicePlan({ ...base, platform: "linux", userHome: "/home/relay", home: "/home/relay/.harness", isolation: { kind: "container", bin: "/usr/bin/container" } });
    expect(p.content).toContain("ExecStart=/usr/bin/container start --attach relay-work");
    expect(p.content).toContain("Description=relay worker: keeps the relay-work container running");
    expect(p.content).toContain("Restart=always");
    expect(p.content).not.toContain("RELAY_HOME");
  });
});

describe("container plan (relay work --isolation container)", () => {
  const spec = { bin: "/usr/local/bin/container", image: "relay-worker:0.1.0", context: "/Users/kyle/.harness/container", site: "https://relay.example.com", workerName: "mac-container", host: "mac.local" };
  it("names the worker after the host", () => {
    expect(containerWorkerName("Studio.local")).toBe("studio-container");
    expect(containerWorkerName("mac")).toBe("mac-container");
  });
  it("creates relay-work on the named volume with no host mounts, the runtime masks off, and the worker identity in the environment", () => {
    const p = containerPlan({ ...spec, args: ["--lanes", "claude,codex"], env: { RELAY_LANE_ALLOWED_DOMAINS: "pkg.example" } });
    expect(p.build).toEqual(["/usr/local/bin/container", "build", "--tag", "relay-worker:0.1.0", "/Users/kyle/.harness/container"]);
    expect(p.volumeCreate).toEqual(["/usr/local/bin/container", "volume", "create", CONTAINER_VOLUME]);
    expect(p.create.slice(0, 4)).toEqual(["/usr/local/bin/container", "create", "--name", CONTAINER_NAME]);
    expect(p.create).toContain(`${CONTAINER_VOLUME}:/home/relay`);
    expect(p.create.join(" ")).toContain("--publish 127.0.0.1:3000:3000 --publish 127.0.0.1:1455:1455 --masked-path NONE --read-only-path NONE --memory 4G --cpus 4");
    expect(containerPlan({ ...spec, memory: "8G", cpus: 6 }).create.join(" ")).toContain("--memory 8G --cpus 6");
    expect(p.create.join(" ")).toContain("--env RELAY_HOME=/home/relay/.harness");
    expect(p.create.join(" ")).toContain("--env RELAY_ISOLATION=container");
    expect(p.create.join(" ")).toContain("--env RELAY_WORKER_NAME=mac-container");
    expect(p.create.join(" ")).toContain("--env RELAY_WORKER_HOST=mac.local");
    expect(p.create.join(" ")).toContain("--env RELAY_LANE_ALLOWED_DOMAINS=pkg.example");
    expect(p.create.slice(-4)).toEqual(["relay-worker:0.1.0", "relay", "work", "--lanes", "claude,codex"].slice(1));
    expect(p.create.filter((w) => w === "--mount" || w.startsWith("type=bind"))).toEqual([]);
    expect(p.create.join(" ")).not.toContain("/Users/");
  });
  it("installs relay from npm when the context has no tarball", () => {
    const p = containerPlan({ ...spec, relaySpec: "@kyleroche/relay@0.1.0" });
    expect(p.build).toContain("--build-arg");
    expect(p.build).toContain("RELAY_SPEC=@kyleroche/relay@0.1.0");
  });
  it("runs setup, the shell and doctor inside as the relay user; the service attaches", () => {
    const p = containerPlan({ ...spec, invite: "abc" });
    expect(p.setup).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "relay", "setup", "--site", "https://relay.example.com", "--name", "relay-cli@mac-container", "--invite", "abc"]);
    expect(p.shell).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "bash"]);
    expect(p.doctor).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "relay", "doctor"]);
    expect(p.attach).toEqual(["/usr/local/bin/container", "start", "--attach", "relay-work"]);
    expect(p.logs(true, 20)).toEqual(["/usr/local/bin/container", "logs", "--follow", "-n", "20", "relay-work"]);
    expect(p.remove).toEqual(["/usr/local/bin/container", "delete", "relay-work"]);
  });
  it("reads the container's state from `container list --all --format json`", () => {
    const json = JSON.stringify([
      { configuration: { id: "buildkit", image: { reference: "ghcr.io/apple/container-builder-shim/builder:0.13.1" } }, status: { state: "running" } },
      { configuration: { id: "relay-work", image: { reference: "relay-worker:0.1.0" } }, status: { state: "stopped" } },
    ]);
    expect(containerStateFrom(json)).toEqual({ exists: true, running: false, state: "stopped", image: "relay-worker:0.1.0" });
    expect(containerStateFrom(JSON.stringify([{ configuration: { id: "relay-work" }, status: { state: "running" } }]))).toEqual({ exists: true, running: true, state: "running" });
    expect(containerStateFrom("[]")).toEqual({ exists: false, running: false });
    expect(containerStateFrom("not json")).toEqual({ exists: false, running: false });
  });
  it("reads the lanes line of `relay doctor` output", () => {
    expect(lanesFromDoctorOutput("ok    node          v24.1.0\nok    lanes         claude, codex (relay work would serve these); not: grok: no grok CLI or fx login\nok    sandbox       x")).toEqual(["claude", "codex"]);
    expect(lanesFromDoctorOutput("warn  lanes         none: gh is not logged in (run: gh auth login); no lane can push without it")).toEqual([]);
    expect(lanesFromDoctorOutput("ok    node          v24.1.0")).toBeUndefined();
  });
  it("probes the site token in the volume and tells relay-entry which login ports to forward", () => {
    const p = containerPlan(spec);
    expect(p.credentials).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "test", "-f", "/home/relay/.harness/credentials.json"]);
    expect(p.create.join(" ")).toContain("--env RELAY_LOGIN_PORTS=3000 1455");
  });
  it("spells the login commands: fx with its browser off and stdin open, claude and gh on a TTY, the redirect replay with curl inside", () => {
    const p = containerPlan(spec);
    expect(p.login.fx("grok")).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-i", "relay-work", "env", "FX_NO_OPEN_BROWSER=1", "fx", "login", "grok"]);
    expect(p.login.fx("codex").slice(-2)).toEqual(["login", "codex"]);
    expect(p.login.claude).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "claude"]);
    expect(p.login.gh).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "gh", "auth", "login", "--git-protocol", "https", "--web"]);
    expect(p.login.ghSetupGit).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "gh", "auth", "setup-git"]);
    expect(p.login.replay("http://localhost:1455/auth/callback?code=c&state=s")).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "curl", "-fsS", "-o", "/dev/null", "http://localhost:1455/auth/callback?code=c&state=s"]);
  });

  const DOCTOR_INSIDE = [
    "ok    node          v24.11.0",
    "ok    cli:claude    /usr/local/bin/claude",
    "ok    login:claude  logged in (max)",
    "warn  cli:codex     not on PATH",
    "ok    cli:fx        /usr/local/bin/fx",
    "ok    login:fx      connected: codex",
    "warn  cli:grok      not on PATH",
    "ok    cli:gh        /usr/bin/gh",
    "fail  login:gh      not logged in; run: gh auth login",
    "warn  lanes         none: gh is not logged in (run: gh auth login); no lane can push without it",
    "ok    mode          site: https://relay.example.com (memory, feed, token, invite, task and webhook commands and the hooks use it)",
    "ok    auth          approved on /activate (device flow) as oauth:relay-cli@mac-container, expires 2026-11-16T22:10:02.000Z; renews itself with a refresh token",
  ].join("\n");

  it("reads the logins from `relay doctor` output inside: fx covers codex and grok, an expired fx counts as missing", () => {
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE)).toEqual({ claude: true, gh: false, codex: true, grok: false });
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE.replace("ok    login:fx      connected: codex", "ok    login:fx      connected: codex, grok").replace("fail  login:gh      not logged in; run: gh auth login", "ok    login:gh      logged in"))).toEqual({ claude: true, gh: true, codex: true, grok: true });
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE.replace("ok    login:fx      connected: codex", "warn  login:fx      connected: codex; token expired and not refreshable, run: fx login"))).toEqual({ claude: true, gh: false, codex: false, grok: false });
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE.replace("warn  cli:grok      not on PATH", "ok    cli:grok      /usr/local/bin/grok")).grok).toBe(true);
    expect(loginStatesFromDoctorOutput("")).toEqual({ claude: false, gh: false, codex: false, grok: false });
  });
  it("reads the token's name from doctor's auth line", () => {
    expect(tokenNameFromDoctorOutput(DOCTOR_INSIDE)).toBe("oauth:relay-cli@mac-container");
    expect(tokenNameFromDoctorOutput("ok    auth          pasted with --token as ci, no expiry")).toBe("ci");
    expect(tokenNameFromDoctorOutput("ok    auth          pasted with --token, no expiry")).toBeUndefined();
    expect(tokenNameFromDoctorOutput("")).toBeUndefined();
  });
  it("marks the login steps the volume already holds as kept; without doctor output every step is an instruction", () => {
    const unknown = containerLoginSteps();
    expect(unknown.allKept).toBe(false);
    expect(unknown.steps.map((s) => s.cmd)).toEqual(CONTAINER_LOGIN_STEPS.map((s) => s.cmd));
    expect(unknown.steps.every((s) => s.kept === undefined)).toBe(true);
    const some = containerLoginSteps(DOCTOR_INSIDE);
    expect(some.allKept).toBe(false);
    expect(some.steps.map((s) => [s.cmd, s.kept])).toEqual([
      ["relay work container shell", undefined],
      ["claude", true],
      ["gh auth login && gh auth setup-git", false],
      ["fx login codex", true],
      ["FX_NO_OPEN_BROWSER=1 fx login grok", false],
      ["exit", undefined],
    ]);
    const all = containerLoginSteps(DOCTOR_INSIDE.replace("ok    login:fx      connected: codex", "ok    login:fx      connected: codex, grok").replace("fail  login:gh      not logged in; run: gh auth login", "ok    login:gh      logged in"));
    expect(all.allKept).toBe(true);
    expect(all.steps.filter((s) => s.kept).map((s) => s.login)).toEqual(["claude", "gh", "codex", "grok"]);
  });
  it("reads the settings an update carries over from the container's row: the baked arguments, the passthrough env, the name, the size", () => {
    const row = {
      configuration: {
        id: "relay-work",
        image: { reference: "relay-worker:0.1.0" },
        initProcess: {
          arguments: ["relay", "work", "--lanes", "claude", "--jobs", "2"],
          environment: ["PATH=/usr/local/bin:/usr/bin", "RELAY_HOME=/home/relay/.harness", "RELAY_ISOLATION=container", "RELAY_WORKER_NAME=mac-container", "RELAY_WORKER_HOST=mac.local", "RELAY_LANE_ALLOWED_DOMAINS=pkg.example", "RELAY_LOGIN_PORTS=3000 1455", "NODE_VERSION=24.11.0"],
        },
        resources: { cpuOverhead: 1, cpus: 6, memoryInBytes: 8 * 2 ** 30 },
      },
      status: { state: "running" },
    };
    expect(containerSettingsFrom(JSON.stringify([row]))).toEqual({ args: ["--lanes", "claude", "--jobs", "2"], env: { RELAY_LANE_ALLOWED_DOMAINS: "pkg.example" }, workerName: "mac-container", host: "mac.local", memory: "8G", cpus: 6 });
    expect(containerSettingsFrom(JSON.stringify([{ configuration: { id: "relay-work", initProcess: { arguments: ["sleep", "infinity"] } } }]))).toEqual({ args: [], env: {} });
    expect(containerSettingsFrom("[]")).toBeUndefined();
    expect(containerSettingsFrom("nope")).toBeUndefined();
    expect(fmtMemory(4 * 2 ** 30)).toBe("4G");
    expect(fmtMemory(1536 * 2 ** 20)).toBe("1536M");
    expect(fmtMemory(2 ** 10)).toBe("1K");
    expect(fmtMemory(1000)).toBe("1000");
  });
  it("says whether the container runs this relay's image", () => {
    expect(imageStatus("relay-worker:0.2.0", "relay-worker:0.2.0")).toEqual({ current: true, line: "relay-worker:0.2.0 (this relay's build)" });
    const stale = imageStatus("relay-worker:0.1.0", "relay-worker:0.2.0");
    expect(stale.current).toBe(false);
    expect(stale.line).toContain("rebuild with relay work container update");
    expect(imageStatus(undefined, "relay-worker:0.2.0").current).toBe(false);
  });
});

describe("container login helpers (relay work container login)", () => {
  const GROK_URL = "https://auth.x.ai/oauth2/authorize?response_type=code&client_id=fx&redirect_uri=http%3A%2F%2F127.0.0.1%3A42723%2Fcallback&scope=openid&state=st4te&code_challenge=abc";
  const CODEX_URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=xyz";
  it("finds fx's authorize URL in its output and reads the loopback redirect it registered", () => {
    const grok = parseLoginUrl(`Open this URL in your browser to sign in:\n\n  ${GROK_URL}\n\nPaste the code shown by xAI and press enter: `);
    expect(grok).toEqual({ url: GROK_URL, redirectUri: "http://127.0.0.1:42723/callback", host: "127.0.0.1", port: 42723, path: "/callback", state: "st4te" });
    const codex = parseLoginUrl(`Sign in at ${CODEX_URL}.`);
    expect(codex).toMatchObject({ url: CODEX_URL, host: "localhost", port: 1455, path: "/auth/callback", state: "xyz" });
    // a URL without a redirect, a redirect to another host, or a cut chunk: not yet
    expect(parseLoginUrl("see https://docs.x.ai/login for help")).toBeUndefined();
    expect(parseLoginUrl("https://auth.example/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb")).toBeUndefined();
    expect(parseLoginUrl(GROK_URL.slice(0, 60))).toBeUndefined();
    expect(parseLoginUrl("")).toBeUndefined();
  });
  it("reads the code, state and errors from the browser's redirect, and replays it to the listener inside", () => {
    expect(parseLoginCallback("/callback?state=st4te&code=abc.def-123")).toEqual({ code: "abc.def-123", state: "st4te" });
    expect(parseLoginCallback("/auth/callback?error=access_denied&error_description=The+user+denied")).toEqual({ error: "access_denied", errorDescription: "The user denied" });
    expect(parseLoginCallback("/callback")).toEqual({});
    const codex = parseLoginUrl(CODEX_URL)!;
    expect(replayUrl(codex, "/auth/callback?code=c0de&state=xyz")).toBe("http://localhost:1455/auth/callback?code=c0de&state=xyz");
  });
  it("names the providers, their words and the by-hand steps", () => {
    expect(LOGIN_PROVIDERS).toEqual(["claude", "gh", "codex", "grok"]);
    expect(OAUTH_PROVIDERS).toEqual(["codex", "grok"]);
    expect(isLoginProvider("grok")).toBe(true);
    expect(isLoginProvider("vercel")).toBe(false);
    expect(fxLoginWords("grok")).toEqual(["env", "FX_NO_OPEN_BROWSER=1", "fx", "login", "grok"]);
    expect(manualLoginSteps("grok")[1]).toContain("paste only the code value");
    expect(manualLoginSteps("codex")[1]).toContain("fx login codex");
    expect(manualLoginSteps("gh")[1]).toContain("gh auth setup-git");
    expect(manualLoginSteps("claude")[1]).toContain("/login");
    expect(loginDonePage("grok", true)).toContain("grok: signed in");
    expect(loginDonePage("grok", false, "access_denied <x>")).toContain("access_denied &lt;x&gt;");
    expect(CONTAINER_LOGIN_COMMAND).toBe("relay work container login all");
  });
});
