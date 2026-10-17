/**
 * The container tier against the real runtime (docs/WORKERS.md, "Isolation"): build the worker image from
 * packages/cli/container with this checkout's packed tarball, create a container on a throwaway volume with the same
 * flags `relay work --isolation container --install` uses, run `relay --version`, `relay doctor` and the bubblewrap
 * probe inside as the relay user, then remove everything. Runs only with `container` on PATH and
 * RELAY_TEST_CONTAINER=1 (it pulls a base image and takes a minute or two); CI skips it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { containerPlan, containerStateFrom, lanesFromDoctorOutput, runtimePaths } from "@relay/core";
import { onPath } from "../src/commands/_common.ts";

const bin = onPath("container");
const enabled = !!bin && process.env.RELAY_TEST_CONTAINER === "1";
const suffix = `${process.pid}`;
const name = `relay-test-${suffix}`;
const volume = `relay-test-home-${suffix}`;
const image = "relay-worker-test";
/** Host ports for the published login callbacks: 2xxxx, so the test runs beside a live relay-work holding 3000 and 1455. */
const PORT_OFFSET = 20_000;
const cli = resolve(import.meta.dirname, "..");
const root = resolve(cli, "..", "..");

const run = (words: string[], opts: { cwd?: string; timeoutMs?: number } = {}) => {
  const r = spawnSync(words[0]!, words.slice(1), { encoding: "utf8", cwd: opts.cwd ?? root, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

describe.skipIf(!enabled)("relay-worker image under Apple container (RELAY_TEST_CONTAINER=1)", () => {
  let ctx: string;
  // the plan the CLI would make, with the test's names in place of relay-work and relay-work-home
  let plan: ReturnType<typeof containerPlan>;
  let create: string[];

  beforeAll(() => {
    ctx = mkdtempSync(join(tmpdir(), "relay-container-ctx-"));
    const rp = runtimePaths(root);
    for (const f of ["Dockerfile", "relay-entry"]) copyFileSync(join(rp.containerDir, f), join(ctx, f));
    // the same relay the host runs: build the package and pack it into the context
    execFileSync("pnpm", ["--filter", "@kyleroche/relay", "build"], { cwd: root, stdio: "inherit" });
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", ctx], { cwd: cli, stdio: "inherit" });
    expect(readdirSync(ctx).some((f) => f.endsWith(".tgz"))).toBe(true);
    plan = containerPlan({ bin: bin!, image, context: ctx, site: "https://relay.example.com", workerName: "test-container", host: "test" });
    // substitute the test's container and volume names into the create words, and move the published login ports off
    // the loopback ports a live relay-work on this Mac already holds (host 2xxxx → the container's own port)
    create = plan.create.map((w) => (w === "relay-work" ? name : w === "relay-work-home:/home/relay" ? `${volume}:/home/relay` : w.replace(/^127\.0\.0\.1:(\d+):(\d+)$/, (_, h: string, c: string) => `127.0.0.1:${PORT_OFFSET + Number(h)}:${c}`)));
    // the container must stay up for exec: sleep instead of `relay work` (still through the image's entry point)
    const i = create.indexOf("relay");
    create = [...create.slice(0, i), "sleep", "infinity"];
  }, 600_000);

  afterAll(() => {
    if (bin) {
      spawnSync(bin, ["stop", name], { timeout: 60_000 });
      spawnSync(bin, ["delete", name], { timeout: 60_000 });
      spawnSync(bin, ["volume", "delete", volume], { timeout: 60_000 });
    }
    if (ctx) rmSync(ctx, { recursive: true, force: true });
  });

  it("builds the image, runs relay and relay doctor inside as the relay user, and bubblewrap starts", () => {
    const build = run(plan.build);
    expect(build.code, build.out.slice(-2000)).toBe(0);

    const vol = run([bin!, "volume", "create", volume]);
    expect(vol.code, vol.out).toBe(0);
    const created = run(create, { timeoutMs: 120_000 });
    expect(created.code, created.out).toBe(0);
    const started = run([bin!, "start", name], { timeoutMs: 120_000 });
    expect(started.code, started.out).toBe(0);
    const state = containerStateFrom(run([bin!, "list", "--all", "--format", "json"]).out, name);
    expect(state.running).toBe(true);

    const exec = (argv: string[]) => run([bin!, "exec", "--user", "relay", name, ...argv], { timeoutMs: 180_000 });
    // the entry point handed the volume to the relay user
    const who = exec(["sh", "-c", "id -un; stat -c %U /home/relay; echo $RELAY_HOME; echo $RELAY_ISOLATION"]);
    expect(who.out.trim().split("\n")).toEqual(["relay", "relay", "/home/relay/.harness", "container"]);
    // and started the login-callback forwarders (eth0 → loopback) for the ports the plan publishes, as the relay user
    const socat = exec(["sh", "-c", "pgrep -u relay -a socat || ps -o args= -C socat"]);
    expect(socat.out, socat.out).toContain("TCP-LISTEN:3000,");
    expect(socat.out).toContain("TCP-LISTEN:1455,");
    expect(socat.out).toContain("TCP:127.0.0.1:1455");
    // from the Mac, the published port reaches the forwarder: the connection is accepted (and closed, since no login
    // server listens inside yet: curl's "empty reply" 52 or "recv failure" 56), never refused (7) as it was without it
    const probe = run(["curl", "-s", "-o", "/dev/null", "--max-time", "10", `http://127.0.0.1:${PORT_OFFSET + 1455}/`], { timeoutMs: 20_000 });
    expect(probe.code, `curl exit ${probe.code}: ${probe.out}`).not.toBe(7);

    const version = exec(["relay", "--version"]);
    expect(version.code, version.out).toBe(0);
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+/);

    // doctor exits 1 (no logins inside) but reports node, the CLIs, the lanes line and the sandbox line
    const doctor = exec(["relay", "doctor"]);
    expect(doctor.out).toMatch(/^ok\s+node\s+v24/m);
    expect(doctor.out).toMatch(/^ok\s+cli:claude/m);
    expect(doctor.out).toMatch(/^ok\s+cli:gh/m);
    expect(doctor.out).toMatch(/^ok\s+cli:fx/m);
    expect(lanesFromDoctorOutput(doctor.out)).toEqual([]);
    expect(doctor.out).toMatch(/^ok\s+sandbox\s+bubblewrap and socat on PATH/m);
    expect(doctor.out).not.toMatch(/container\s+/); // the host-only line is absent inside

    // the nested sandbox's smallest requirement, as the worker probes it
    const bwrap = exec(["bwrap", "--unshare-all", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "echo", "bwrap-ok"]);
    expect(bwrap.code, bwrap.out).toBe(0);
    expect(bwrap.out).toContain("bwrap-ok");

    // the tools the lanes need
    for (const [tool, re] of [
      [["claude", "--version"], /\d+\.\d+\.\d+/],
      [["gh", "--version"], /gh version/],
      [["fx", "--version"], /\d+\.\d+\.\d+/],
      [["pnpm", "--version"], /\d+\.\d+\.\d+/],
      [["git", "--version"], /git version/],
    ] as const) {
      const r = exec([...tool]);
      expect(r.code, `${tool.join(" ")}: ${r.out}`).toBe(0);
      expect(r.out).toMatch(re);
    }
  }, 900_000);
});
