/**
 * `relay work` command parsing for the container tier: `--isolation`, the `container` subcommands and the install
 * plan, against recorded shell words instead of the real `container` CLI.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { CONTAINER_NAME, CONTAINER_VOLUME } from "@relay/core";
import { bakedArgs, isolationOf, registerWork, type WorkDeps } from "../src/commands/work.ts";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "relay-work-cli-"));
  process.env.RELAY_HOME = home;
  delete process.env.RELAY_SITE;
  delete process.env.RELAY_TOKEN;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

const LIST_STOPPED = JSON.stringify([{ configuration: { id: CONTAINER_NAME, image: { reference: "relay-worker:0.1.0" } }, status: { state: "stopped" } }]);

/** A `container` CLI that answers the probes and records everything else. */
function fakeDeps(opts: { list?: string; hasContainer?: boolean } = {}) {
  const sh: string[][] = [];
  const run: string[][] = [];
  const deps: WorkDeps = {
    sh(words) {
      sh.push(words);
      const [, sub, sub2] = words;
      if (sub === "system" && sub2 === "status") return { ok: true, out: "FIELD   VALUE\nstatus  running\nclient.version 1.5.0" };
      if (sub === "list") return { ok: true, out: opts.list ?? "[]" };
      if (sub === "volume" && sub2 === "list") return { ok: true, out: "NAME  TYPE  DRIVER  OPTIONS" };
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
    expect(printed).toMatch(new RegExp(`container create --name ${CONTAINER_NAME} --volume ${CONTAINER_VOLUME}:/home/relay --publish 127.0.0.1:3000:3000 --masked-path NONE --read-only-path NONE`));
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
