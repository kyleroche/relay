/**
 * The task state cache (db/task-state.ts, migration 010): every write that can change a task rewrites its cached
 * state and station; the backfill fills rows the cache never saw (including through the migration runner); and the
 * flow map's one-query snapshot returns exactly what the old per-task fold returned, for a fraction of the queries.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus } from "../src/db/tasks.ts";
import { backfillTaskState, flowTasks, refreshTaskState } from "../src/db/task-state.ts";
import { deriveStation, failureLine, FLOW_DONE_MS, FLOW_FAILED_MS, IN_MOTION, taskTitle } from "../src/tasks/station.ts";
import { requeueTask } from "../src/tasks/requeue.ts";
import { approveTask } from "../src/tasks/review.ts";
import type { GitHubClient, GitHubIssue, GitHubPull } from "../src/github/client.ts";

let db: Db;
let issue = 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const S = 1000;
const M = 60 * S;

beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
});
afterAll(async () => {
  await db.close();
});

/** The cached columns of one task, straight from the row. */
async function cache(id: string) {
  const r = await db.query(`SELECT state, station, since, pr, pr_url, preview_state, preview_url, runner, last_error, cost, title, state_updated_at FROM tasks WHERE id = $1`, [id]);
  const x = r[0]!;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return { ...x, since: iso(x.since), state_updated_at: iso(x.state_updated_at), pr: x.pr == null ? null : Number(x.pr), cost: x.cost == null ? null : Number(x.cost) };
}

const open = async (lane: string, opts: { title?: string; createdBy?: string } = {}) =>
  (await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: ++issue, createdBy: opts.createdBy ?? "human:kyle", lane, title: opts.title ?? `Task ${issue}` })).task;

const write = (t: repo.TaskRow, kind: string, extra: Partial<repo.EventInput> = {}) =>
  repo.writeEvent(db, { project: "demo", repo: t.repo, issue: t.issue, lane: t.lane, actor: "runner:mini", summary: kind, kind, ...extra });

/** A GitHub that merges whatever it is asked to and remembers nothing it does not need to. */
function fakeGitHub(): GitHubClient {
  return {
    source: "token",
    async createIssue(repo, input): Promise<GitHubIssue> {
      return { number: 1, title: input.title, body: input.body, state: "open", html_url: `https://github.com/${repo}/issues/1`, labels: input.labels ?? [] };
    },
    async addLabels() {},
    async removeLabel() {},
    async getIssue(repo, n): Promise<GitHubIssue> {
      return { number: n, title: "t", body: "", state: "open", html_url: `https://github.com/${repo}/issues/${n}`, labels: ["agent:claude"] };
    },
    async request() {
      return {};
    },
    async createComment(repo, n) {
      return { id: 1, html_url: `https://github.com/${repo}/pull/${n}#issuecomment-1` };
    },
    async getPullRequest(repo, number): Promise<GitHubPull> {
      return { number, title: "Add dark mode", state: "open", merged: false, html_url: `https://github.com/${repo}/pull/${number}`, head_ref: `relay/claude-${issue}`, head_sha: "abc1234", base_ref: "main", user: "relay-agent" };
    },
    async mergePullRequest() {
      return { sha: "deadbeef", merged: true, message: "merged" };
    },
    async deleteBranch() {},
  };
}

describe("refreshTaskState after each write path", () => {
  it("createTask caches queued at Queue since the row was created, with the title", async () => {
    const t = await open("claude", { title: "Add dark mode" });
    const c = await cache(t.id);
    expect(c).toMatchObject({ state: "queued", station: "Queue", pr: null, runner: null, preview_state: "none", last_error: null, cost: null, title: "Add dark mode" });
    expect(c.since).toBe(t.created_at);
    expect(c.state_updated_at).toBeTruthy();
  });

  it("claimNext caches claimed with the worker's name; releaseClaim puts it back", async () => {
    const t = await open("codex");
    const { worker } = await repo.registerWorker(db, { name: "ts-claimer", lanes: ["codex"] });
    const got = await repo.claimNext(db, { workerId: worker.id, lanes: ["codex"] });
    expect(got?.task.id).toBe(t.id);
    expect(await cache(t.id)).toMatchObject({ state: "claimed", station: "Claimed", runner: "runner:ts-claimer" });
    expect((await cache(t.id)).since).toBe(got!.claim.claimed_at);
    await repo.releaseClaim(db, t.id, worker.id, "released");
    expect(await cache(t.id)).toMatchObject({ state: "queued", station: "Queue", runner: null });
  });

  it("run.started -> running, pr.opened -> review at PR, preview.ready -> Preview, task.approved (merged) -> done at Merged", async () => {
    const t = await open("claude");
    const branch = `relay/claude-${t.issue}`;
    await write(t, "run.started", { ts: ago(10 * M), payload: { branch } });
    expect(await cache(t.id)).toMatchObject({ state: "running", station: "Running", since: ago(10 * M), runner: "runner:mini" });

    await write(t, "step.usage", { ts: ago(6 * M), actor: "agent:claude", model: "claude-opus-4-1", tokens_in: 1000, tokens_out: 100, cost_equiv: 0.25 });
    await write(t, "pr.opened", { ts: ago(5 * M), actor: "agent:claude", pr: 9, url: "https://github.com/acme/demo/pull/9", summary: `Add dark mode (#${t.issue})`, payload: { branch } });
    expect(await cache(t.id)).toMatchObject({ state: "review", station: "PR", since: ago(5 * M), pr: 9, pr_url: "https://github.com/acme/demo/pull/9", preview_state: "none", cost: 0.25 });

    // Vercel's webhook knows the PR and the ref, not the issue: the preview still reaches this task
    const prev = await repo.writeEvent(db, { kind: "preview.ready", actor: "bot:vercel", project: "demo", repo: "acme/demo", pr: 9, url: "https://demo-abc.vercel.app", summary: "preview", ts: ago(4 * M), payload: { ref: branch } });
    expect(prev?.issue).toBeNull();
    expect(await cache(t.id)).toMatchObject({ state: "review", station: "Preview", since: ago(4 * M), preview_state: "ready", preview_url: "https://demo-abc.vercel.app" });

    await write(t, "pr.review", { ts: ago(3 * M), actor: "human:kyle", pr: 9 });
    expect(await cache(t.id)).toMatchObject({ state: "review", station: "Review", since: ago(3 * M) });

    const r = await approveTask(db, fakeGitHub(), t.id, "human:kyle");
    expect(r.task.state).toBe("done");
    const c = await cache(t.id);
    expect(c).toMatchObject({ state: "done", station: "Merged", pr: 9 });
    expect(c.since).toBe(r.events[0]!.ts);
  });

  it("run.failed -> failed at Failed with the error line; a requeue -> queued at Queue", async () => {
    const t = await open("claude");
    await write(t, "run.started", { ts: ago(20 * M) });
    await write(t, "run.failed", { ts: ago(15 * M), summary: "claude exited 1", payload: { error: "pnpm typecheck failed" } });
    expect(await cache(t.id)).toMatchObject({ state: "failed", station: "Failed", since: ago(15 * M), last_error: "pnpm typecheck failed" });

    const r = await requeueTask(db, fakeGitHub(), t.id, "human:kyle", { reason: "flaky" });
    expect(r.task.state).toBe("queued");
    const c = await cache(t.id);
    // the fold keeps the last runner's name on a requeued task (it says who ran it last); the state and the error move
    expect(c).toMatchObject({ state: "queued", station: "Queue", last_error: null, runner: "runner:mini" });
    expect(c.since).toBe(r.events[0]!.ts);
  });

  it("a failing run.finished is failed; task.changes_requested and pr.closed re-queue; run.dispatched runs on the cloud line", async () => {
    const t = await open("claude");
    await write(t, "run.started", { ts: ago(9 * M) });
    await write(t, "run.finished", { ts: ago(8 * M), summary: "no changes", payload: { conclusion: "failure" } });
    expect(await cache(t.id)).toMatchObject({ state: "failed", station: "Failed", last_error: "no changes" });
    await write(t, "run.started", { ts: ago(7 * M) });
    await write(t, "run.finished", { ts: ago(6 * M), pr: 11, payload: { conclusion: "success" } });
    expect(await cache(t.id)).toMatchObject({ state: "review", station: "PR", pr: 11, pr_url: "https://github.com/acme/demo/pull/11", last_error: null });
    await write(t, "task.changes_requested", { ts: ago(5 * M), actor: "human:kyle", pr: 11, payload: { note: "tests" } });
    expect(await cache(t.id)).toMatchObject({ state: "queued", station: "Queue", since: ago(5 * M) });
    await write(t, "pr.opened", { ts: ago(4 * M), pr: 11 });
    await write(t, "pr.closed", { ts: ago(3 * M), pr: 11 });
    expect(await cache(t.id)).toMatchObject({ state: "queued", station: "Queue", since: ago(3 * M) });

    const cloud = await open("codex-cloud");
    await write(cloud, "run.dispatched", { ts: ago(2 * M), actor: "bot:codex" });
    expect(await cache(cloud.id)).toMatchObject({ state: "running", station: "Running", since: ago(2 * M), runner: null });
  });

  it("expireLeases puts a vanished worker's task back in the queue in the cache too", async () => {
    const t = await open("grok");
    const { worker } = await repo.registerWorker(db, { name: "ts-vanisher", lanes: ["grok"] });
    // a short lease, live while the run starts (the refresh folds at the wall clock)
    const got = await repo.claimNext(db, { workerId: worker.id, lanes: ["grok"], leaseMs: 60 * M, now: NOW });
    expect(got?.task.id).toBe(t.id);
    await write(t, "run.started", { ts: new Date(NOW + 10).toISOString(), actor: "runner:ts-vanisher" });
    expect(await cache(t.id)).toMatchObject({ state: "running", station: "Running", runner: "runner:ts-vanisher" });
    // an hour later the heartbeat never renewed it: the lease ran out, nobody released it
    const later = NOW + 61 * M;
    const expired = await repo.expireLeases(db, later);
    expect(expired.map((c) => c.task_id)).toContain(t.id);
    expect(await cache(t.id)).toMatchObject({ state: "queued", station: "Queue", runner: "runner:ts-vanisher" });
    expect((await cache(t.id)).state_updated_at).toBe(new Date(later).toISOString());
  });

  it("an event about an issue relay does not track, or without an issue, refreshes nothing and stays cheap", async () => {
    let n = 0;
    const counting: Db = { ...db, query: (sql, params) => (n++, db.query(sql, params)) };
    await repo.writeEvent(counting, { kind: "step.usage", actor: "agent:claude", project: "demo", summary: "a model call", tokens_in: 10 });
    expect(n).toBe(1);
    n = 0;
    await repo.writeEvent(counting, { kind: "run.started", actor: "runner:mini", repo: "acme/demo", issue: 999_999, summary: "unknown issue" });
    expect(n).toBe(2); // the insert, then one lookup that finds no task row
  });
});

describe("backfill", () => {
  it("fills rows whose cache is empty; listTaskViews and flowTasks fill what they meet", async () => {
    const a = await open("claude");
    await write(a, "run.started", { ts: ago(M) });
    const b = await open("claude");
    await db.query("UPDATE tasks SET state = NULL, station = NULL, since = NULL, runner = NULL WHERE id = ANY($1::text[])", [[a.id, b.id]]);
    expect((await cache(a.id)).state).toBeNull();

    const running = await repo.listTaskViews(db, { state: "running", limit: 500 });
    expect(running.some((v) => v.id === a.id)).toBe(true);
    expect((await cache(a.id))).toMatchObject({ state: "running", station: "Running", runner: "runner:mini" });
    expect((await cache(b.id)).state).toBe("queued"); // the filter admits NULL rows and folds them too

    await db.query("UPDATE tasks SET state = NULL WHERE id = ANY($1::text[])", [[a.id, b.id]]);
    expect(await backfillTaskState(db)).toBe(2);
    expect(await backfillTaskState(db)).toBe(0);
    expect((await cache(a.id)).state).toBe("running");

    await db.query("UPDATE tasks SET state = NULL WHERE id = $1", [b.id]);
    const flow = await flowTasks(db, { now: NOW, limit: 500 });
    expect(flow.find((r) => r.id === b.id)).toMatchObject({ state: "queued", station: "Queue" });
    expect((await cache(b.id)).state).toBe("queued");
  });

  it("the migration runner backfills every task when 010 lands on a database that predates it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mig-"));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR)) if (/^00\d_/.test(f)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const old = await openDb({ file: ":memory:" });
      try {
        expect(await migrate(old, { dir })).toBe(9);
        await repo.upsertProject(old, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
        // rows as a 009 process wrote them: no title, no cache, events straight into the table
        await old.query("INSERT INTO tasks (id, project, repo, issue, created_by, lane) VALUES ('acme/demo#1', 'demo', 'acme/demo', 1, 'human:kyle', 'claude'), ('acme/demo#2', 'demo', 'acme/demo', 2, 'bot:grok', 'codex')");
        await old.query("INSERT INTO events (ts, kind, actor, project, repo, issue, summary, payload) VALUES ($1, 'issue.opened', 'human:kyle', 'demo', 'acme/demo', 1, 'Add dark mode', '{}'), ($2, 'run.started', 'runner:mini', 'demo', 'acme/demo', 1, 'claude on mini', '{}'), ($3, 'task.created', 'bot:grok', 'demo', 'acme/demo', 2, 'acme/demo#2: Fix the footer', '{}')", [ago(3 * M), ago(2 * M), ago(M)]);
        const log: string[] = [];
        expect(await migrate(old, { log: (s) => log.push(s) })).toBeGreaterThanOrEqual(10);
        expect(log.some((l) => l.includes("cached the state of 2 tasks"))).toBe(true);
        const rows = await old.query("SELECT id, state, station, title, runner FROM tasks ORDER BY id");
        expect(rows).toEqual([
          { id: "acme/demo#1", state: "running", station: "Running", title: "Add dark mode", runner: "runner:mini" },
          { id: "acme/demo#2", state: "queued", station: "Queue", title: "Fix the footer", runner: null },
        ]);
      } finally {
        await old.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** What the old per-task path computed: every task folded, filtered to what the map draws. The oracle. */
interface OracleRow {
  id: string;
  state: string;
  station: string;
  since: string;
  pr: number | null;
  pr_url: string | null;
  preview_state: string;
  preview_url: string | null;
  runner: string | null;
  title: string;
  error: string | null;
  cost: number | null;
}
async function oracleFlow(h: Db, now: number): Promise<OracleRow[]> {
  const rows = await repo.listTasks(h, { limit: 200 });
  const views = await Promise.all(
    rows.map(async (row) => {
      const [events, claims] = await Promise.all([repo.taskEvents(h, row), repo.taskClaims(h, row.id)]);
      const status = deriveTaskStatus(row, events, claims, now);
      const live = [...claims].sort((a, b) => a.claimed_at.localeCompare(b.claimed_at)).at(-1);
      const claimedAt = live && !live.released_at && new Date(live.lease_until).getTime() > now ? live.claimed_at : null;
      const { station, since } = deriveStation({ ...status, created_at: row.created_at }, events, { claimedAt, now });
      return {
        id: row.id,
        state: status.state,
        station,
        since,
        pr: status.pr,
        pr_url: status.pr_url,
        preview_state: status.preview_state,
        preview_url: status.preview_url,
        runner: status.runner,
        title: taskTitle(row, events),
        error: status.state === "failed" ? failureLine(events) ?? null : null,
        cost: status.usage?.cost_equiv ?? null,
      } satisfies OracleRow;
    }),
  );
  const sinceMs = (t: { since: string }) => new Date(t.since).getTime();
  return views.filter((t) => IN_MOTION.has(t.state as repo.TaskState) || (t.state === "done" && now - sinceMs(t) < FLOW_DONE_MS) || (t.state === "failed" && now - sinceMs(t) < FLOW_FAILED_MS));
}

describe("flowTasks: the one-query snapshot", () => {
  it("returns the tasks the per-task fold returned, with the same stations, for a fraction of the queries", async () => {
    // a fresh database so the counts are about this set alone
    const h = await openDb({ file: ":memory:" });
    try {
      await migrate(h);
      await repo.upsertProject(h, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
      await repo.upsertProject(h, { slug: "other", repo: "acme/other", path: "/tmp/other" });
      let n = 0;
      const mk = async (lane: string, project = "demo", repoName = "acme/demo") => (await repo.createTask(h, { project, repo: repoName, issue: ++n, createdBy: "human:kyle", lane, title: `T${n}` })).task;
      const w = (t: repo.TaskRow, kind: string, extra: Partial<repo.EventInput> = {}) => repo.writeEvent(h, { project: t.project, repo: t.repo, issue: t.issue, lane: t.lane, actor: "runner:mini", summary: kind, kind, ...extra });
      const { worker } = await repo.registerWorker(h, { name: "mini", lanes: ["claude", "codex", "grok"] });

      await mk("claude"); // queued, nothing yet
      const claimed = await mk("codex");
      expect((await repo.claimNext(h, { workerId: worker.id, lanes: ["codex"], now: NOW - 2 * M }))?.task.id).toBe(claimed.id);
      const running = await mk("claude", "other", "acme/other");
      await w(running, "run.started", { ts: ago(8 * M), payload: { branch: `relay/claude-${running.issue}` } });
      const pr = await mk("claude");
      await w(pr, "run.started", { ts: ago(30 * M) });
      await w(pr, "step.usage", { ts: ago(26 * M), actor: "agent:claude", cost_equiv: 0.5 });
      await w(pr, "run.finished", { ts: ago(25 * M), pr: 1, payload: { conclusion: "success" } });
      await w(pr, "pr.opened", { ts: ago(24 * M), pr: 1, url: "https://github.com/acme/demo/pull/1", payload: { branch: `relay/claude-${pr.issue}` } });
      const preview = await mk("grok");
      await w(preview, "pr.opened", { ts: ago(20 * M), pr: 2, payload: { branch: `relay/grok-${preview.issue}` } });
      await repo.writeEvent(h, { kind: "preview.ready", actor: "bot:vercel", project: "demo", repo: "acme/demo", pr: 2, url: "https://p2.vercel.app", summary: "preview", ts: ago(19 * M), payload: { ref: `relay/grok-${preview.issue}` } });
      const review = await mk("claude");
      await w(review, "pr.opened", { ts: ago(18 * M), pr: 3 });
      await w(review, "pr.review", { ts: ago(17 * M), actor: "human:kyle", pr: 3 });
      const doneFresh = await mk("codex");
      await w(doneFresh, "pr.opened", { ts: ago(10 * M), pr: 4 });
      await w(doneFresh, "task.approved", { ts: ago(30 * S), actor: "human:kyle", pr: 4, payload: { merged: true } });
      const doneOld = await mk("codex");
      await w(doneOld, "pr.opened", { ts: ago(3 * 60 * M), pr: 5 });
      await w(doneOld, "pr.merged", { ts: ago(60 * M), pr: 5 });
      const failedFresh = await mk("claude");
      await w(failedFresh, "run.started", { ts: ago(40 * M) });
      await w(failedFresh, "run.failed", { ts: ago(35 * M), summary: "claude exited 1", payload: { error: "tests failed" } });
      const failedOld = await mk("claude");
      await w(failedOld, "run.started", { ts: ago(50 * 60 * M) });
      await w(failedOld, "run.failed", { ts: ago(49 * 60 * M), summary: "timed out" });
      const sentBack = await mk("grok");
      await w(sentBack, "pr.opened", { ts: ago(15 * M), pr: 6 });
      await w(sentBack, "task.changes_requested", { ts: ago(14 * M), actor: "human:kyle", pr: 6, payload: { note: "more" } });
      const cloud = await mk("codex-cloud");
      await w(cloud, "run.dispatched", { ts: ago(12 * M), actor: "bot:codex" });
      // codex: the one claimed task holds a live lease and the done ones are not queued, so this is the next codex claim
      const vanished = await mk("codex");
      expect((await repo.claimNext(h, { workerId: worker.id, lanes: ["codex"], leaseMs: 6 * M, now: NOW - 6 * M }))?.task.id).toBe(vanished.id);
      await w(vanished, "run.started", { ts: ago(5 * M) });
      await repo.expireLeases(h, NOW);

      let count = 0;
      const counting: Db = { ...h, query: (sql, params) => (count++, h.query(sql, params)) };

      count = 0;
      const before = await oracleFlow(counting, NOW);
      const oracleQueries = count;
      count = 0;
      const rows = await flowTasks(counting, { now: NOW, limit: 200 });
      const snapshotQueries = count;

      const after: OracleRow[] = rows.map((r) => ({
        id: r.id,
        state: r.state,
        station: r.station,
        since: r.since,
        pr: r.pr,
        pr_url: r.pr_url,
        preview_state: r.preview_state,
        preview_url: r.preview_url,
        runner: r.runner,
        title: r.title ?? `#${r.issue}`,
        error: r.last_error,
        cost: r.cost,
      }));
      expect(after).toEqual(before);
      const station = Object.fromEntries(after.map((t) => [t.id, t.station]));
      expect(station).toEqual({
        "acme/demo#1": "Queue",
        [claimed.id]: "Claimed",
        [running.id]: "Running",
        [pr.id]: "PR",
        [preview.id]: "Preview",
        [review.id]: "Review",
        [doneFresh.id]: "Merged",
        [failedFresh.id]: "Failed",
        [sentBack.id]: "Queue",
        [cloud.id]: "Running",
        [vanished.id]: "Queue",
      });
      expect(after.find((t) => t.id === failedFresh.id)?.error).toBe("tests failed");
      expect(after.find((t) => t.id === pr.id)?.cost).toBe(0.5);
      expect(rows.find((r) => r.id === running.id)?.project_repo).toBe("acme/other");
      expect(after.map((t) => t.id)).not.toContain(doneOld.id);
      expect(after.map((t) => t.id)).not.toContain(failedOld.id);

      // 13 tasks: the old path ran one list plus events and claims per task; the new one runs one query
      expect(oracleQueries).toBe(1 + 2 * 13);
      expect(snapshotQueries).toBe(1);
      console.log(`flow snapshot over ${n} tasks: ${oracleQueries} queries per poll before, ${snapshotQueries} after`);
    } finally {
      await h.close();
    }
  });
});
