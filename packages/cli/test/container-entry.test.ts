/**
 * The image's entry point (packages/cli/container/relay-entry) against stubbed system tools: it hands the volume to the
 * relay user, starts one socat login-callback forwarder per port in RELAY_LOGIN_PORTS from the container's eth0
 * address to its loopback (as the relay user, in the background), and drops to the relay user for the command.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dirname, "..", "container", "relay-entry");
let bin: string;
let runs = 0;

/** A stub on PATH that appends its name and arguments to this run's call log ($RELAY_ENTRY_CALLS), then runs `body`. */
function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$RELAY_ENTRY_CALLS"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  // one log per run: the forwarders are background processes whose stubs may write after the entry script has exited
  const calls = join(bin, `calls-${++runs}.log`);
  writeFileSync(calls, "");
  const r = spawnSync("/bin/sh", [entry, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, RELAY_ENTRY_CALLS: calls, ...env }, timeout: 20_000 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(calls, "utf8").trimEnd().split("\n").filter(Boolean) };
}

/** The socat invocations of a run, as the stub recorded them, in a fixed order (they start in the background). */
const socats = (calls: string[]): string[] => calls.filter((c) => c.startsWith("socat ")).sort();

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "relay-entry-bin-"));
  stub("id", 'case "$1" in -u) echo 1000;; -g) echo 1000;; esac');
  // the volume arrives owned by root (0); .harness is not there yet
  stub("stat", "echo 0");
  stub("chown", "");
  stub("install", "");
  // setpriv drops its own options and runs the command, as the real one does
  stub("setpriv", 'while [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done; exec "$@"');
  stub("socat", "");
  stub("hostname", "echo 192.168.64.22 fdc3::1");
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

describe("relay-entry", () => {
  it("hands the volume over, forwards every RELAY_LOGIN_PORTS port from eth0 to loopback as the relay user, then runs the command as relay", () => {
    const r = run(["echo", "hello"], { RELAY_LOGIN_PORTS: "3000 1455" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("hello");
    expect(r.calls).toContain("chown 1000:1000 /home/relay");
    expect(r.calls).toContain("install -d -o 1000 -g 1000 /home/relay/.harness");
    // each forwarder was started through setpriv as the relay user, then ran
    expect(r.calls.filter((c) => c.startsWith("setpriv --reuid=1000 --regid=1000 --init-groups socat ")).sort()).toEqual([
      "setpriv --reuid=1000 --regid=1000 --init-groups socat TCP-LISTEN:1455,bind=192.168.64.22,reuseaddr,fork TCP:127.0.0.1:1455",
      "setpriv --reuid=1000 --regid=1000 --init-groups socat TCP-LISTEN:3000,bind=192.168.64.22,reuseaddr,fork TCP:127.0.0.1:3000",
    ]);
    expect(socats(r.calls)).toEqual(["socat TCP-LISTEN:1455,bind=192.168.64.22,reuseaddr,fork TCP:127.0.0.1:1455", "socat TCP-LISTEN:3000,bind=192.168.64.22,reuseaddr,fork TCP:127.0.0.1:3000"]);
    expect(r.calls).toContain("setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/relay USER=relay LOGNAME=relay echo hello");
  });
  it("defaults to the ports the plan publishes (3000, 1455); an empty RELAY_LOGIN_PORTS turns the forwarders off", () => {
    const byDefault = run(["true"]);
    expect(byDefault.code).toBe(0);
    expect(socats(byDefault.calls).map((c) => c.split(" ")[1])).toEqual(["TCP-LISTEN:1455,bind=192.168.64.22,reuseaddr,fork", "TCP-LISTEN:3000,bind=192.168.64.22,reuseaddr,fork"]);
    const off = run(["true"], { RELAY_LOGIN_PORTS: "" });
    expect(off.code).toBe(0);
    expect(off.calls.some((c) => c.includes("socat"))).toBe(false);
  });
  it("skips the forwarders without an address and still runs the command", () => {
    stub("hostname", "echo");
    const r = run(["true"]);
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("socat"))).toBe(false);
    expect(r.calls.at(-1)).toContain("env HOME=/home/relay USER=relay LOGNAME=relay true");
    stub("hostname", "echo 192.168.64.22 fdc3::1");
  });
});
