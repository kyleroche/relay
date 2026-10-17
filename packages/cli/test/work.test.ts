/**
 * `relay work` command parsing for the container tier: `--isolation`, the `container` subcommands and the install
 * plan, against recorded shell words instead of the real `container` CLI.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { CONTAINER_NAME, CONTAINER_VOLUME } from "@relay/core";
import { bakedArgs, isolationOf, registerWork, type WorkDeps } from "../src/commands/work.ts";

let home: string;
let userHome: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "relay-work-cli-"));
  userHome = mkdtempSync(join(tmpdir(), "relay-work-user-"));
  process.env.RELAY_HOME = home;
  // the service plan's LaunchAgent lands here, never in the real ~/Library/LaunchAgents
  process.env.RELAY_USER_HOME = userHome;
  delete process.env.RELAY_SITE;
  delete process.env.RELAY_TOKEN;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
  delete process.env.RELAY_USER_HOME;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const LIST_STOPPED = JSON.stringify([{ configuration: { id: CONTAINER_NAME, image: { reference: "relay-worker:0.1.0" } }, status: { state: "stopped" } }]);
/** `relay-work` running on an older image, created by `--install --lanes claude --jobs 2 --cpus 6` with an allowed-domains passthrough. */
const LIST_RUNNING_OLD = JSON.stringify([
  { configuration: { id: "buildkit", image: { reference: "ghcr.io/apple/container-builder-shim/builder:0.13.1" } }, status: { state: "running" } },
  {
    configuration: {
      id: CONTAINER_NAME,
      image: { reference: "relay-worker:0.1.0" },
      initProcess: {
        arguments: ["relay", "work", "--lanes", "claude", "--jobs", "2"],
        environment: ["PATH=/usr/local/bin:/usr/bin", "RELAY_HOME=/home/relay/.harness", "RELAY_ISOLATION=container", "RELAY_WORKER_NAME=mac-container", "RELAY_WORKER_HOST=mac", "RELAY_LANE_ALLOWED_DOMAINS=pkg.example"],
      },
      resources: { cpuOverhead: 1, cpus: 6, memoryInBytes: 4 * 2 ** 30 },
    },
    status: { state: "running" },
  },
]);
/** `relay doctor` inside: claude and fx codex logged in, gh and grok not, the site joined through the device flow. */
const DOCTOR_PARTIAL = [
  "ok    node          v24.11.0",
  "ok    cli:claude    /usr/local/bin/claude",
  "ok    login:claude  logged in (max)",
  "ok    cli:fx        /usr/local/bin/fx",
  "ok    login:fx      connected: codex",
  "warn  cli:grok      not on PATH",
  "ok    cli:gh        /usr/bin/gh",
  "fail  login:gh      not logged in; run: gh auth login",
  "warn  lanes         none: gh is not logged in (run: gh auth login); no lane can push without it",
  "ok    auth          approved on /activate (device flow) as oauth:relay-cli@mac-container, expires 2026-11-16T22:10:02.000Z; renews itself with a refresh token",
].join("\n");
const DOCTOR_ALL = DOCTOR_PARTIAL.replace("ok    login:fx      connected: codex", "ok    login:fx      connected: codex, grok")
  .replace("fail  login:gh      not logged in; run: gh auth login", "ok    login:gh      logged in")
  .replace("warn  lanes         none: gh is not logged in (run: gh auth login); no lane can push without it", "ok    lanes         claude, codex, grok (relay work would serve these)");

/** The stand-in for `fx login` inside the container: prints an authorize URL for FAKE_PORT, then waits for the code on stdin (fixtures/fake-fx-login.mjs). */
const FAKE_FX = resolve(import.meta.dirname, "fixtures", "fake-fx-login.mjs");

/**
 * A `container` CLI that answers the probes (including the ones inside the container) and records everything else.
 * `login` adds a fake fx process in place of `container exec … fx login` (its port, code and behaviour from `fx`) and
 * a fake browser: what `open <url>` does, usually a fetch of the redirect to the listener on this machine.
 */
function fakeDeps(opts: { list?: string; hasContainer?: boolean; credentials?: boolean; doctor?: string; fx?: { port: number; code?: string; mode?: string }; browser?: (url: string) => void; publishedPorts?: number[] } = {}) {
  const sh: string[][] = [];
  const run: string[][] = [];
  const spawned: string[][] = [];
  const children: ChildProcess[] = [];
  const deps: WorkDeps = {
    sh(words) {
      sh.push(words);
      const [, sub, sub2] = words;
      if (words[0] === "open" || words[0] === "xdg-open") {
        opts.browser?.(words[1]!);
        return { ok: true, out: "" };
      }
      if (sub === "system" && sub2 === "status") return { ok: true, out: "FIELD   VALUE\nstatus  running\nclient.version 1.5.0" };
      if (sub === "list") return { ok: true, out: opts.list ?? "[]" };
      if (sub === "volume" && sub2 === "list") return { ok: true, out: "NAME  TYPE  DRIVER  OPTIONS" };
      if (sub === "exec" && words.includes("test")) return { ok: !!opts.credentials, out: "" };
      // doctor exits 1 while a login is missing; the report is its output either way
      if (sub === "exec" && words.includes("doctor")) return { ok: opts.doctor === DOCTOR_ALL, out: opts.doctor ?? "" };
      if (words[0] === "launchctl" && words[1] === "print") return { ok: false, out: "not loaded" };
      return { ok: true, out: "" };
    },
    run(words) {
      run.push(words);
      return 0;
    },
    spawn(words) {
      spawned.push(words);
      const provider = words.at(-1)!;
      const child = spawn(process.execPath, [FAKE_FX, provider], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FAKE_PORT: String(opts.fx?.port ?? 0), FAKE_CODE: opts.fx?.code ?? "", FAKE_MODE: opts.fx?.mode ?? "paste" },
      });
      children.push(child);
      return child;
    },
    ...(opts.publishedPorts ? { publishedPorts: opts.publishedPorts } : {}),
    onPath: (bin) => (bin === "container" && opts.hasContainer !== false ? "/usr/local/bin/container" : undefined),
    platform: "darwin",
  };
  return { deps, sh, run, spawned, children };
}

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => res(port));
    });
  });
}
/** A port this test holds, so the login's listener cannot have it. */
function holdPort(): Promise<{ port: number; server: Server }> {
  return new Promise((res) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => res({ port: (server.address() as AddressInfo).port, server }));
  });
}
const exited = (c: ChildProcess): Promise<void> => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((res) => c.once("exit", () => res())));
/** The browser: the redirect fx registered, with the state and this code, to whatever listens at `url`'s redirect port. */
const redirectTo = (url: string, code: string): Promise<Response> => {
  const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
  return fetch(`${redirect.origin}${redirect.pathname}?state=st4te&code=${encodeURIComponent(code)}`);
};

function program(deps: WorkDeps): Command {
  // as main.ts builds it: positional options the whole way down, so `container rm --yes` is rm's option
  const p = new Command().exitOverride().enablePositionalOptions();
  p.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerWork(p, "0.1.0-test", deps);
  return p;
}

describe("relay work: isolation flag", () => {
  it("accepts host and container, refuses anything else", () => {
    expect(isolationOf(undefined)).toBe("host");
    expect(isolationOf("container")).toBe("container");
    expect(isolationOf("Container")).toBe("container");
    expect(() => isolationOf("vm")).toThrow(/--isolation: 'vm' is not one of host, container/);
  });
  it("bakes the worker options into arguments the same way for the service and the container", () => {
    expect(bakedArgs({ jobs: "1" })).toEqual([]);
    expect(bakedArgs({ lanes: "claude", labels: "gpu", jobs: "2", maxInterval: "900", sandbox: false })).toEqual(["--lanes", "claude", "--labels", "gpu", "--jobs", "2", "--max-interval", "900", "--no-sandbox"]);
  });
  it("rejects an unknown isolation before doing anything", async () => {
    const f = fakeDeps();
    await expect(program(f.deps).parseAsync(["node", "relay", "work", "--isolation", "vm", "--install"])).rejects.toThrow(/--isolation/);
    expect(f.sh).toEqual([]);
  });
});

describe("relay work container <cmd>", () => {
  it("shell is `container exec --user relay -it relay-work bash`", async () => {
    const f = fakeDeps();
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "shell"]);
    expect(f.run).toEqual([["/usr/local/bin/container", "exec", "--user", "relay", "-it", CONTAINER_NAME, "bash"]]);
  });
  it("logs passes --follow and -n through", async () => {
    const f = fakeDeps();
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "logs", "-f", "-n", "20"]);
    expect(f.run).toEqual([["/usr/local/bin/container", "logs", "--follow", "-n", "20", CONTAINER_NAME]]);
  });
  it("rm plans stop and delete, keeps the volume unless --volume, and needs --yes", async () => {
    const f = fakeDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "rm"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain(`container stop ${CONTAINER_NAME}`);
    expect(printed).toContain(`container delete ${CONTAINER_NAME}`);
    expect(printed).not.toContain("volume delete");
    expect(f.sh.filter((w) => w[1] === "stop" || w[1] === "delete")).toEqual([]);
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "rm", "--volume", "--yes"]);
    expect(f.sh).toContainEqual(["/usr/local/bin/container", "stop", CONTAINER_NAME]);
    expect(f.sh).toContainEqual(["/usr/local/bin/container", "delete", CONTAINER_NAME]);
    expect(f.sh).toContainEqual(["/usr/local/bin/container", "volume", "delete", CONTAINER_VOLUME]);
  });
  it("says what to install when the container CLI is missing", async () => {
    const f = fakeDeps({ hasContainer: false });
    await expect(program(f.deps).parseAsync(["node", "relay", "work", "container", "shell"])).rejects.toThrow(/container CLI is not on PATH/);
  });
});

describe("relay work --isolation container --install (plan only)", () => {
  it("prints the image, volume, create, setup and service steps and the login sequence, and runs nothing without --yes", async () => {
    const f = fakeDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "--isolation", "container", "--install", "--site", "https://relay.example.com", "--lanes", "claude", "--jobs", "2"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("container build --tag relay-worker:0.1.0-test");
    expect(printed).toContain(`container volume create ${CONTAINER_VOLUME}`);
    expect(printed).toMatch(new RegExp(`container create --name ${CONTAINER_NAME} --volume ${CONTAINER_VOLUME}:/home/relay --publish 127.0.0.1:3000:3000 --publish 127.0.0.1:1455:1455 --masked-path NONE --read-only-path NONE`));
    expect(printed).toContain("--env RELAY_ISOLATION=container");
    expect(printed).toMatch(/--env RELAY_WORKER_NAME=[a-z0-9._-]+-container/);
    expect(printed).toMatch(/relay-worker:0.1.0-test relay work --lanes claude --jobs 2$/m);
    expect(printed).toContain(`container exec --user relay -it ${CONTAINER_NAME} relay setup --site https://relay.example.com --name relay-cli@`);
    expect(printed).toContain("<string>--attach</string>");
    expect(printed).toContain(`<string>${CONTAINER_NAME}</string>`);
    expect(printed).toContain("relay work container shell");
    expect(printed).toContain("gh auth login && gh auth setup-git");
    expect(printed).toContain("re-run with --yes");
    // only probes ran: system status, list, volume list
    expect(f.run).toEqual([]);
    expect(f.sh.map((w) => w.slice(1, 3).join(" "))).toEqual(["system status", "list --all", "volume list"]);
  });
  it("needs a site: the container cannot see this machine's local database", async () => {
    const f = fakeDeps();
    await expect(program(f.deps).parseAsync(["node", "relay", "work", "--isolation", "container", "--install"])).rejects.toThrow(/--site <url>/);
  });
  it("--install --yes over a running container that already joined: recreates it, skips relay setup, prints the logins still missing", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, credentials: true, doctor: DOCTOR_PARTIAL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "--isolation", "container", "--install", "--yes", "--site", "https://relay.example.com", "--lanes", "claude"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
    // the plan said so before doing it
    expect(printed).toContain("site        joined as oauth:relay-cli@mac-container (kept: /home/relay/.harness/credentials.json is in the volume)");
    expect(printed).not.toContain("relay setup --site");
    // the image is built (interactive run, last after the checkout's own build and pack) before the old container is touched
    expect(f.run.at(-1)).toEqual(["/usr/local/bin/container", "build", "--tag", "relay-worker:0.1.0-test", join(home, "container")]);
    expect(f.run.some((w) => w.includes("setup"))).toBe(false);
    // the probes while planning, then stop, delete, create, start, the probes again, stop (the service attaches)
    const probe = [`exec --user relay ${CONTAINER_NAME} test -f /home/relay/.harness/credentials.json`, `exec --user relay ${CONTAINER_NAME} relay doctor`];
    const steps = f.sh.filter((w) => w[0] === "/usr/local/bin/container" && !/^(system|list|volume)$/.test(w[1]!)).map((w) => w.slice(1).join(" "));
    expect(steps).toEqual([
      ...probe,
      `stop ${CONTAINER_NAME}`,
      `delete ${CONTAINER_NAME}`,
      expect.stringMatching(/^create --name relay-work --volume relay-work-home:\/home\/relay --publish 127\.0\.0\.1:3000:3000 --publish 127\.0\.0\.1:1455:1455 .* relay-worker:0\.1\.0-test relay work --lanes claude$/),
      `start ${CONTAINER_NAME}`,
      ...probe,
      `stop ${CONTAINER_NAME}`,
    ]);
    expect(logged).toContain("site: joined as oauth:relay-cli@mac-container (kept)");
    expect(logged).toContain("removed the previous relay-work (relay-worker:0.1.0)");
    // the service file went under RELAY_USER_HOME, and the login list marks what the volume holds
    expect(existsSync(join(userHome, "Library", "LaunchAgents", "house.kyro.relay.work.plist"))).toBe(true);
    // the one command first, the by-hand list under it
    expect(printed).toMatch(/^ {2}relay work container login all\s+one command; opens this Mac's browser for each login/m);
    expect(printed).toMatch(/^ {4}claude\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ {4}fx login codex\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ {4}gh auth login && gh auth setup-git\s+the account the worker clones/m);
    expect(printed).toMatch(/^ {4}FX_NO_OPEN_BROWSER=1 fx login grok\s+optional: the grok lane/m);
  });
  it("--uninstall keeps the volume and says how to delete it", async () => {
    const f = fakeDeps({ list: LIST_STOPPED });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "--isolation", "container", "--uninstall"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain(`container stop ${CONTAINER_NAME}`);
    expect(printed).toContain(`container delete ${CONTAINER_NAME}`);
    expect(printed).toContain(`container volume delete ${CONTAINER_VOLUME}`);
    expect(f.sh.filter((w) => w[1] === "delete")).toEqual([]);
  });
});

describe("relay work container update", () => {
  it("plans the rebuild with the container's own settings carried over, keeps the joined site, marks the logins the volume holds, and runs nothing without --yes", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, credentials: true, doctor: DOCTOR_PARTIAL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "update"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("would run   /usr/local/bin/container build --tag relay-worker:0.1.0-test");
    expect(printed).toContain("relay-work runs relay-worker:0.1.0; the old image stays until the new one is built");
    expect(printed).toContain(`would run   /usr/local/bin/container stop ${CONTAINER_NAME}; /usr/local/bin/container delete ${CONTAINER_NAME}  (recreated from the new image with today's flags; the volume keeps the logins)`);
    // today's create flags (the published ports, the forwarded ports) with yesterday's choices
    expect(printed).toMatch(/would run   \/usr\/local\/bin\/container create --name relay-work --volume relay-work-home:\/home\/relay --publish 127\.0\.0\.1:3000:3000 --publish 127\.0\.0\.1:1455:1455 --masked-path NONE --read-only-path NONE --memory 4G --cpus 6 .*--env RELAY_WORKER_NAME=mac-container --env RELAY_WORKER_HOST=mac --env RELAY_LOGIN_PORTS=3000 1455 --env RELAY_LANE_ALLOWED_DOMAINS=pkg.example relay-worker:0\.1\.0-test relay work --lanes claude --jobs 2  \(carried over: --lanes claude --jobs 2, RELAY_LANE_ALLOWED_DOMAINS, --memory 4G, --cpus 6\)/);
    expect(printed).toContain(`would run   /usr/local/bin/container exec --user relay ${CONTAINER_NAME} test -f /home/relay/.harness/credentials.json  (a site token in the volume means no device flow)`);
    expect(printed).toContain("site        joined as oauth:relay-cli@mac-container (kept: /home/relay/.harness/credentials.json is in the volume)");
    expect(printed).not.toContain("relay setup --site");
    expect(printed).toContain("then        log in inside:");
    expect(printed).toMatch(/^ +relay work container login all\s+one command/m);
    expect(printed).toMatch(/^ +claude\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ +fx login codex\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ +gh auth login && gh auth setup-git\s+the account the worker clones/m);
    expect(printed).toMatch(/^ +FX_NO_OPEN_BROWSER=1 fx login grok\s+optional: the grok lane; open the printed URL/m);
    expect(printed).toContain("re-run with --yes to rebuild the image, recreate the container and restart the service");
    // only probes ran, on the Mac and inside
    expect(f.run).toEqual([]);
    expect(f.sh.filter((w) => w[0] === "/usr/local/bin/container").map((w) => w.slice(1, 3).join(" "))).toEqual(["system status", "list --all", "volume list", "exec --user", "exec --user"]);
  });
  it("without a token in the volume it plans relay setup --site inside, and needs a site for that", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, credentials: false, doctor: DOCTOR_PARTIAL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "update", "--site", "https://relay.example.com"]);
    let printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain(`would run   /usr/local/bin/container exec --user relay -it ${CONTAINER_NAME} relay setup --site https://relay.example.com --name relay-cli@mac-container  (interactive: the device flow prints its code here)`);
    expect(printed).not.toContain("site        joined as");
    out.mockClear();
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "update"]);
    printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("site        none in the volume yet: pass --site <url>");
    expect(f.run).toEqual([]);
  });
  it("on a stopped container the volume cannot be probed yet: setup is planned as conditional and every login is an instruction", async () => {
    const f = fakeDeps({ list: LIST_STOPPED });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "update", "--site", "https://relay.example.com"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("relay setup --site https://relay.example.com --name relay-cli@");
    expect(printed).toContain("skipped when /home/relay/.harness/credentials.json is in the volume");
    expect(printed).not.toContain("kept (already in the volume)");
    expect(printed).toContain("(the logins already in the volume are kept; relay work container status says which)");
    expect(f.sh.filter((w) => w[1] === "exec")).toEqual([]);
  });
  it("all logins present: one line instead of the list", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, credentials: true, doctor: DOCTOR_ALL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "update"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("logins      kept in the volume: claude, gh, codex, grok (relay doctor inside)");
    expect(printed).not.toContain("then        log in inside");
  });
  it("--memory and --cpus override what the container has; the rest stays", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, credentials: true, doctor: DOCTOR_ALL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "update", "--memory", "8G", "--cpus", "2"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/container create .* --memory 8G --cpus 2 .* relay work --lanes claude --jobs 2/);
  });
  it("needs a container to update", async () => {
    const f = fakeDeps();
    await expect(program(f.deps).parseAsync(["node", "relay", "work", "container", "update"])).rejects.toThrow(/no relay-work container to update; create one with: relay work --isolation container --install/);
    expect(f.run).toEqual([]);
  });
});

describe("relay work container status", () => {
  it("prints the image the container runs and says to update when this relay would build another", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "status"]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain(`container: ${CONTAINER_NAME} running`);
    expect(printed).toContain("image:     relay-worker:0.1.0; this relay would build relay-worker:0.1.0-test: rebuild with relay work container update");
    expect(printed).toContain("  fail  login:gh      not logged in; run: gh auth login");
    expect(printed).toContain("lanes:     none yet; log in with: relay work container login all");
    expect(f.sh).toContainEqual(["/usr/local/bin/container", "exec", "--user", "relay", CONTAINER_NAME, "relay", "doctor"]);
  });
  it("says the image is current when the tags match, and stops at a stopped container", async () => {
    const current = LIST_RUNNING_OLD.replace("relay-worker:0.1.0", "relay-worker:0.1.0-test");
    const f = fakeDeps({ list: current, doctor: DOCTOR_ALL });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    await program(f.deps).parseAsync(["node", "relay", "work", "container", "status"]);
    let printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("image:     relay-worker:0.1.0-test (this relay's build)");
    expect(printed).toContain("lanes:     claude, codex, grok (the container worker serves these)");
    out.mockClear();
    const g = fakeDeps({ list: LIST_STOPPED });
    await program(g.deps).parseAsync(["node", "relay", "work", "container", "status"]);
    printed = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("image:     relay-worker:0.1.0; this relay would build relay-worker:0.1.0-test: rebuild with relay work container update");
    expect(printed).toContain("start it with: relay work container start");
    expect(g.sh.filter((w) => w[1] === "exec")).toEqual([]);
  });
});

describe("relay work container login", () => {
  const CODE = "xai-c0de.single-use";
  const login = (deps: WorkDeps, ...args: string[]) => program(deps).parseAsync(["node", "relay", "work", "container", "login", ...args]);
  const capture = () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    return () => out.mock.calls.map((c) => String(c[0])).join("\n");
  };

  it("grok: reads fx's authorize URL, listens on this Mac at the redirect port, opens the browser, answers the redirect and pastes the code to fx", async () => {
    const port = await freePort();
    let page = "";
    const f = fakeDeps({
      list: LIST_RUNNING_OLD,
      doctor: DOCTOR_PARTIAL,
      fx: { port, code: CODE },
      browser: (url) => void redirectTo(url, CODE).then(async (r) => (page = await r.text())),
    });
    const printed = capture();
    await login(f.deps, "grok");
    const text = printed();
    // fx ran inside with its browser off and stdin open
    expect(f.spawned).toEqual([["/usr/local/bin/container", "exec", "--user", "relay", "-i", CONTAINER_NAME, "env", "FX_NO_OPEN_BROWSER=1", "fx", "login", "grok"]]);
    expect(text).toContain("fx  Open this URL in your browser to sign in:");
    expect(text).toContain(`listening on 127.0.0.1:${port} for the browser's redirect`);
    // the browser was opened on the URL fx printed
    const opened = f.sh.find((w) => w[0] === "open");
    expect(opened?.[1]).toMatch(new RegExp(`^https://auth\\.x\\.ai/oauth2/authorize\\?.*redirect_uri=http%3A%2F%2F127\\.0\\.0\\.1%3A${port}%2Fcallback`));
    expect(text).toContain("opened https://auth.x.ai/oauth2/authorize in this Mac's browser; finish the sign-in there");
    // the redirect got the "signed in" page; the code went to fx's stdin and fx accepted it
    expect(page).toContain("grok: signed in");
    expect(text).toContain("redirect received; pasting the code to fx");
    expect(text).toContain("fx  Signed in to grok.");
    expect(text).toMatch(/^grok\s+signed in$/m);
    expect(text).toContain("logins:    claude ok, gh missing, codex ok, grok missing (relay doctor inside)");
    expect(text).toContain("lanes:     none yet; log in with: relay work container login all");
    expect(process.exitCode).toBeUndefined();
    await exited(f.children[0]!);
  });

  it("codex with the port free on this Mac: the host listener catches the redirect, replays it to the Codex listener inside with curl, and pastes the code too", async () => {
    const port = await freePort();
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port, code: CODE }, browser: (url) => void redirectTo(url, CODE) });
    const printed = capture();
    await login(f.deps, "codex", "--force");
    const text = printed();
    expect(f.spawned[0]!.slice(-3)).toEqual(["fx", "login", "codex"]);
    expect(f.sh).toContainEqual(["/usr/local/bin/container", "exec", "--user", "relay", CONTAINER_NAME, "curl", "-fsS", "-o", "/dev/null", `http://localhost:${port}/auth/callback?state=st4te&code=${encodeURIComponent(CODE)}`]);
    expect(text).toContain(`redirect received; replayed to the Codex listener inside (localhost:${port}) and the code pasted to fx`);
    expect(text).toMatch(/^codex\s+signed in$/m);
    expect(process.exitCode).toBeUndefined();
  });

  it("codex when the redirect port is the container's published port: no host listener, the browser opens, fx finishes through the forwarder", async () => {
    const held = await holdPort();
    try {
      const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port: held.port, mode: "finish" }, publishedPorts: [held.port] });
      const printed = capture();
      await login(f.deps, "codex", "--force");
      const text = printed();
      expect(text).toContain(`127.0.0.1:${held.port} is the container's published port: the browser's redirect reaches the login server inside through it; waiting for fx to finish`);
      expect(f.sh.some((w) => w[0] === "open")).toBe(true);
      expect(f.sh.some((w) => w.includes("curl"))).toBe(false);
      expect(text).toMatch(/^codex\s+signed in$/m);
      expect(process.exitCode).toBeUndefined();
    } finally {
      held.server.close();
    }
  });

  it("grok when the redirect port is taken on this Mac: refuses, kills fx and prints the by-hand steps", async () => {
    const held = await holdPort();
    try {
      const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port: held.port, code: CODE } });
      const printed = capture();
      await login(f.deps, "grok");
      const text = printed();
      expect(text).toContain(`grok    FAILED: cannot listen on 127.0.0.1:${held.port} for the browser's redirect (the port is in use on this Mac)`);
      expect(text).toContain("by hand:");
      expect(text).toContain("FX_NO_OPEN_BROWSER=1 fx login grok");
      expect(text).toContain("paste only the code value");
      expect(f.sh.some((w) => w[0] === "open")).toBe(false);
      expect(process.exitCode).toBe(1);
      await exited(f.children[0]!);
      expect(f.children[0]!.exitCode === null ? f.children[0]!.signalCode : "exited").toBe("SIGTERM");
    } finally {
      held.server.close();
    }
  });

  it("times out when the browser never comes back, kills fx and prints the by-hand steps", async () => {
    const port = await freePort();
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port, mode: "hang" } });
    const printed = capture();
    await login(f.deps, "grok", "--timeout", "1");
    const text = printed();
    expect(text).toContain("grok    FAILED: timed out after 1s waiting for the browser login");
    expect(text).toContain("relay work container shell");
    expect(process.exitCode).toBe(1);
    await exited(f.children[0]!);
  });

  it("--no-open prints the URL instead of opening the browser; the redirect still completes the login", async () => {
    const port = await freePort();
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port, code: CODE } });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    // the person opens the printed URL themselves: here, as soon as it is printed
    const browser = (async () => {
      for (;;) {
        const line = out.mock.calls.flatMap((c) => String(c[0]).split("\n")).find((l) => l.trim().startsWith("https://auth.x.ai/"));
        if (line) return redirectTo(line.trim(), CODE);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await login(f.deps, "grok", "--no-open");
    await browser;
    const text = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("open this URL on this Mac:");
    expect(f.sh.some((w) => w[0] === "open")).toBe(false);
    expect(text).toMatch(/^grok\s+signed in$/m);
  });

  it("fails cleanly when fx exits before printing a URL", async () => {
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port: 1, mode: "fail" } });
    const printed = capture();
    await login(f.deps, "grok");
    expect(printed()).toContain("grok    FAILED: fx login grok exited 1 before printing an authorize URL");
    expect(process.exitCode).toBe(1);
  });

  it("all: skips the logins the volume holds, runs gh on a TTY then gh auth setup-git, grok through the browser, and ends with the lanes line", async () => {
    const port = await freePort();
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_PARTIAL, fx: { port, code: CODE }, browser: (url) => void redirectTo(url, CODE) });
    const printed = capture();
    await login(f.deps);
    const text = printed();
    expect(text).toMatch(/^claude\s+already in the volume \(relay doctor inside\); skipped \(--force logs in again\)$/m);
    expect(text).toMatch(/^codex\s+already in the volume/m);
    expect(f.run).toEqual([["/usr/local/bin/container", "exec", "--user", "relay", "-it", CONTAINER_NAME, "gh", "auth", "login", "--git-protocol", "https", "--web"]]);
    expect(f.sh).toContainEqual(["/usr/local/bin/container", "exec", "--user", "relay", CONTAINER_NAME, "gh", "auth", "setup-git"]);
    expect(text).toContain("the device code prints below; enter it at github.com/login/device on this Mac");
    expect(text).toMatch(/^gh\s+signed in \(gh auth setup-git done\)$/m);
    expect(f.spawned.map((w) => w.at(-1))).toEqual(["grok"]);
    expect(text).toMatch(/^grok\s+signed in$/m);
    // doctor inside before (what to skip) and after (the report)
    expect(f.sh.filter((w) => w.includes("doctor")).length).toBe(2);
    expect(text.trim().split("\n").at(-1)).toBe("lanes:     none yet; log in with: relay work container login all");
    expect(process.exitCode).toBeUndefined();
  });

  it("all with --force logs claude in on a TTY too, with the /login instruction", async () => {
    const port = await freePort();
    const f = fakeDeps({ list: LIST_RUNNING_OLD, doctor: DOCTOR_ALL, fx: { port, code: CODE }, browser: (url) => void redirectTo(url, CODE) });
    const printed = capture();
    await login(f.deps, "all", "--force");
    const text = printed();
    expect(f.run[0]).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", CONTAINER_NAME, "claude"]);
    expect(text).toContain("type /login, open the URL it prints on this Mac, paste the code back, then /exit");
    expect(f.spawned.map((w) => w.at(-1))).toEqual(["codex", "grok"]);
    expect(text).toContain("lanes:     claude, codex, grok (the container worker serves these)");
  });

  it("needs a running container and a known provider", async () => {
    await expect(login(fakeDeps().deps, "grok")).rejects.toThrow(/no relay-work container; create it with/);
    await expect(login(fakeDeps({ list: LIST_STOPPED }).deps, "grok")).rejects.toThrow(/relay-work is not running; start it with: relay work container start/);
    await expect(login(fakeDeps({ list: LIST_RUNNING_OLD }).deps, "vercel")).rejects.toThrow(/login: 'vercel' is not one of claude, gh, codex, grok, all/);
  });
});
