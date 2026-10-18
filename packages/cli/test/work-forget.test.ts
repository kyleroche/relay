/**
 * `relay work forget <name>` against the embedded database in a scratch RELAY_HOME: the row goes, the past run stays
 * attributed, a second forget is a clean failure, and a worker on a task is refused. The command goes through the
 * same RelayClient the other commands use, so site mode needs no separate path here (packages/mcp/test/client.test.ts
 * pins the HTTP side).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { WorkDeps } from "../src/commands/work.ts";

let home: string;
let core: typeof import("@relay/core");
let registerWork: typeof import("../src/commands/work.ts").registerWork;

/** No service, no container CLI, nothing run: `status` then reads only the database and the scratch home. */
const quietDeps: WorkDeps = {
  sh: () => ({ ok: false, out: "" }),
  run: () => 0,
  spawn: () => {
    throw new Error("nothing is spawned here");
  },
  onPath: () => undefined,
  platform: "linux",
};

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "relay-work-forget-")));
  // RELAY_HOME is read when @relay/core loads, so it goes into the environment before the first import; no site, no
  // DATABASE_URL, so the command opens the PGlite file under this scratch home and nothing else on the machine
  process.env.RELAY_HOME = home;
  process.env.RELAY_USER_HOME = home; // where `status` looks for a service file: never this machine's real one
  delete process.env.DATABASE_URL;
  delete process.env.RELAY_SITE;
  delete process.env.RELAY_TOKEN;
  core = await import("@relay/core");
  ({ registerWork } = await import("../src/commands/work.ts"));
});
afterAll(() => {
  delete process.env.RELAY_USER_HOME;
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Run one `relay work …` and collect what it printed (`log` writes `[relay] …` to stderr, tables to stdout). */
async function run(...args: string[]): Promise<string[]> {
  const out: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
  const program = new Command().exitOverride().enablePositionalOptions();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerWork(program, "0.1.0-test", quietDeps);
  await program.parseAsync(["work", ...args], { from: "user" });
  return out;
}

/** Seed through the core server functions, the way a real worker would have. */
async function withDb<T>(fn: (db: import("@relay/core").Db) => Promise<T>): Promise<T> {
  const h = await core.openHarness();
  try {
    await core.migrate(h.db);
    return await fn(h.db);
  } finally {
    await h.close();
  }
}

describe("relay work forget", () => {
  it("removes a retired worker by name, keeps its run attributed, and says what it removed", async () => {
    const old = await withDb(async (db) => {
      await core.repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
      const reg = await core.registerWorkerServer(db, { name: "kyrobook", host: "kyrobook.local", lanes: ["claude"], version: "0.2.1" });
      const { task } = await core.repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 41, createdBy: "human:kyle", lane: "claude" });
      await core.claimServer(db, { worker_id: reg.worker.id });
      await core.startServer(db, task.id, { worker_id: reg.worker.id });
      await core.releaseServer(db, task.id, { worker_id: reg.worker.id, outcome: "finished", pr: 5, pr_url: "https://github.com/acme/demo/pull/5" });
      return { id: reg.worker.id, task };
    });

    const out = await run("forget", "kyrobook");
    expect(out.join("\n")).toContain(`forgot kyrobook (${old.id}; claude; last seen`);
    expect(out.join("\n")).toContain("registers again if that machine runs relay work");
    expect(process.exitCode).toBeUndefined();

    await withDb(async (db) => {
      expect(await core.repo.getWorkerByName(db, "kyrobook")).toBeUndefined();
      const view = await core.repo.taskView(db, old.task);
      expect(view.state).toBe("review");
      expect(view.runner).toBe("runner:kyrobook");
      const ev = await core.repo.listEvents(db, { kind: "worker.forgotten" });
      expect(ev).toHaveLength(1);
      expect(ev[0]?.actor).toMatch(/^human:/);
      expect(ev[0]?.payload).toMatchObject({ worker: old.id, name: "kyrobook" });
    });

    // gone: the second forget is a clean failure, not a stack
    const again = await run("forget", "kyrobook");
    expect(again.join("\n")).toContain("no worker named 'kyrobook'");
    expect(process.exitCode).toBe(1);
  });

  it("refuses a worker that holds a live claim", async () => {
    await withDb(async (db) => {
      const reg = await core.registerWorkerServer(db, { name: "busy-mac", lanes: ["codex"] });
      await core.repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 42, createdBy: "human:kyle", lane: "codex" });
      expect(await core.claimServer(db, { worker_id: reg.worker.id })).not.toBeNull();
    });
    await expect(run("forget", "busy-mac")).rejects.toMatchObject({ status: 409 });
    await withDb(async (db) => expect(await core.repo.getWorkerByName(db, "busy-mac")).toBeDefined());
  });

  it("status marks a worker offline for more than 7 days as retired and points at forget", async () => {
    await withDb(async (db) => {
      const reg = await core.registerWorkerServer(db, { name: "old-mini", lanes: ["grok"] });
      await db.query("UPDATE workers SET last_seen = now() - interval '9 days' WHERE id = $1", [reg.worker.id]);
    });
    const out = (await run("status")).join("\n");
    expect(out).toMatch(/old-mini\s+retired\s+grok/);
    expect(out).toContain("retired: offline for more than 7 days (old-mini); relay work forget <name> removes one");
  });
});
