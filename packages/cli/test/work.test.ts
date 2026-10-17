/**
 * `relay work` command parsing for the container tier: `--isolation`, the `container` subcommands and the install
 * plan, against recorded shell words instead of the real `container` CLI.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
afterEach(() => vi.restoreAllMocks());

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

/** A `container` CLI that answers the probes (including the ones inside the container) and records everything else. */
function fakeDeps(opts: { list?: string; hasContainer?: boolean; credentials?: boolean; doctor?: string } = {}) {
  const sh: string[][] = [];
  const run: string[][] = [];
  const deps: WorkDeps = {
    sh(words) {
      sh.push(words);
      const [, sub, sub2] = words;
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
    onPath: (bin) => (bin === "container" && opts.hasContainer !== false ? "/usr/local/bin/container" : undefined),
    platform: "darwin",
  };
  return { deps, sh, run };
}

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
    expect(printed).toMatch(/^ {2}claude\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ {2}fx login codex\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ {2}gh auth login && gh auth setup-git\s+the account the worker clones/m);
    expect(printed).toMatch(/^ {2}fx login --no-browser grok\s+optional: the grok lane/m);
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
    expect(printed).toContain("then        log in inside, in this order:");
    expect(printed).toMatch(/^ +claude\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ +fx login codex\s+kept \(already in the volume\)$/m);
    expect(printed).toMatch(/^ +gh auth login && gh auth setup-git\s+the account the worker clones/m);
    expect(printed).toMatch(/^ +fx login --no-browser grok\s+optional: the grok lane; open the printed address/m);
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
    expect(printed).toContain("lanes:     none yet; log in with: relay work container shell");
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
