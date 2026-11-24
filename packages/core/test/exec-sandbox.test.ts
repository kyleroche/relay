/**
 * The real sandbox runtime around a project's command: what `projectExec` promises a worker, checked against the OS
 * and not against a fake. It runs where the runtime is installed and the platform has a sandbox (macOS, or Linux
 * with bubblewrap); elsewhere it is skipped, and job-profile.test.ts covers the wiring with an injected exec.
 * `RELAY_TEST_SRT_CLI` points it at a runtime installed somewhere else.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { projectExec, srtCli } from "../src/work/exec.ts";

const cli = process.env.RELAY_TEST_SRT_CLI ?? srtCli();
const has = (bin: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const able = !!cli && (process.platform === "darwin" || (process.platform === "linux" && has("bwrap") && has("socat")));

describe.skipIf(!able)("a project's command under the sandbox runtime", () => {
  let clone: string;
  let outside: string;
  let secret: string;
  const run = (command: string, hosts: string[] = []) => projectExec({ cli: cli! })(command, { cwd: clone, env: { PATH: process.env.PATH, HOME: homedir(), RELAY_TEST_VALUE: "from-the-job" }, hosts, timeoutMs: 60_000 });

  beforeAll(() => {
    clone = realpathSync(mkdtempSync(join(tmpdir(), "relay-exec-clone-")));
    outside = realpathSync(mkdtempSync(join(homedir(), ".relay-exec-outside-")));
    // a path the sandbox denies reading: the Vercel CLI's auth directory, under a name only this test makes
    secret = join(homedir(), ".config", "board", `relay-exec-test-${process.pid}`);
    mkdirSync(join(homedir(), ".config", "board"), { recursive: true });
    writeFileSync(secret, "not-for-a-job\n");
  });
  afterAll(() => {
    rmSync(clone, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(secret, { force: true });
  });

  it("runs the command in the clone with the job's environment and reports its exit code", async () => {
    const ok = await run('echo "$RELAY_TEST_VALUE" > made.txt && cat made.txt');
    expect(ok).toMatchObject({ code: 0, output: "from-the-job", sandboxed: true });
    expect(readFileSync(join(clone, "made.txt"), "utf8")).toBe("from-the-job\n");
    expect((await run("exit 3")).code).toBe(3);
  });

  it("cannot write outside the clone", async () => {
    const r = await run(`echo x > ${JSON.stringify(join(outside, "escaped.txt"))}`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  it("cannot read a credential path", async () => {
    const r = await run(`cat ${JSON.stringify(secret)}`);
    expect(r.code).not.toBe(0);
    expect(r.output).not.toContain("not-for-a-job");
  });

  it("reaches no host that was not allowed", async () => {
    const r = await run("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com");
    expect(r.output.trim()).not.toBe("200");
  });
});

describe("without the sandbox runtime", () => {
  it("a worker that should sandbox does not run the command at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-exec-none-"));
    try {
      // an empty path is what a machine without the runtime has
      const r = await projectExec({ cli: "" })("echo ran > ran.txt", { cwd: dir, env: { PATH: process.env.PATH } });
      expect(r.code).toBe(127);
      expect(r.output).toContain("was not run");
      expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
