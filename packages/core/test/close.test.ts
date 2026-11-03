/**
 * Close (tasks/close.ts): a task is finished without a merge from any state but done; the issue (and an open PR) is
 * closed on GitHub best effort, a live claim is released, task.closed folds to done and the doorbell drops it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { getQueueVersion } from "../src/db/queue.ts";
import { queuedCount, registerWorker, claimNext, liveClaim } from "../src/db/workers.ts";
import { closeComment, closeTask, TaskCloseError } from "../src/tasks/close.ts";
import { GitHubError, type GitHubClient, type GitHubIssue, type GitHubPull } from "../src/github/client.ts";

let db: Db;
let issue = 300;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "shut", repo: "acme/shut", path: "/tmp/shut" });
});
afterAll(async () => {
  await db.close();
});

const at = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** A GitHub that records the calls a close makes, or fails them all. */
function fakeGitHub(opts: { fail?: boolean; prState?: string } = {}) {
  const calls: string[] = [];
  const comments: string[] = [];
  const boom = () => {
    throw new GitHubError("GitHub POST /repos/acme/shut/issues/1/comments: 502 bad gateway", 502);
  };
  const gh: GitHubClient = {
    source: "token",
    async createIssue(repo, input): Promise<GitHubIssue> {
      return { number: 1, title: input.title, body: input.body, state: "open", html_url: `https://github.com/${repo}/issues/1`, labels: input.labels ?? [] };
    },
    async addLabels() {},
    async removeLabel() {},
    async getIssue(repo, n): Promise<GitHubIssue> {
      return { number: n, title: "t", body: "", state: "open", html_url: `https://github.com/${repo}/issues/${n}`, labels: [] };
    },
    async request(method, path, body) {
      if (opts.fail) boom();
      calls.push(`${method} ${path} ${JSON.stringify(body)}`);
      return {};
    },
    async createComment(_repo, n, body) {
      if (opts.fail) boom();
      comments.push(`${n}: ${body}`);
      return { id: 1, html_url: `https://github.com/acme/shut/issues/${n}#issuecomment-1` };
    },
    async getPullRequest(repo, n): Promise<GitHubPull> {
      return { number: n, title: "pr", state: opts.prState ?? "open", merged: false, html_url: `https://github.com/${repo}/pull/${n}`, head_ref: "relay/claude-1", head_sha: "abc", base_ref: "main", user: "bot" };
    },
    async mergePullRequest() {
      throw new Error("unused");
    },
    async deleteBranch() {},
  };
  return { gh, calls, comments };
}

const open = async (lane: string) => (await repo.createTask(db, { project: "shut", repo: "acme/shut", issue: ++issue, createdBy: "bot:grok", lane })).task;
const state = async (t: repo.TaskRow) => (await repo.taskState(db, t)).state;

describe("closeTask", () => {
  it("closes a queued task: the issue closes as not planned with the reason, task.closed folds to done, the doorbell drops it", async () => {
    const t = await open("claude");
    expect(await state(t)).toBe("queued");
    const before = await queuedCount(db, { lanes: ["claude"] });
    const version = await getQueueVersion(db);
    const { gh, calls, comments } = fakeGitHub();
    const r = await closeTask(db, gh, t.id, "human:kyle", { reason: "opened against a spec the repo does not match" });
    expect(r.task.state).toBe("done");
    expect(r.events.map((e) => e.kind)).toEqual(["task.closed"]);
    const e = r.events[0]!;
    expect(e.summary).toBe(`Closed #${t.issue} without a merge (was queued): opened against a spec the repo does not match`);
    expect(e.payload).toMatchObject({ previous_state: "queued", reason: "opened against a spec the repo does not match", github: { closed: true, pr_closed: null }, claim_released: null });
    expect(comments).toEqual([`${t.issue}: ${closeComment("human:kyle", "opened against a spec the repo does not match")}`]);
    expect(calls).toEqual([`PATCH /repos/acme/shut/issues/${t.issue} {"state":"closed","state_reason":"not_planned"}`]);
    expect(await state(t)).toBe("done");
    expect(await queuedCount(db, { lanes: ["claude"] })).toBe(before - 1);
    expect(await getQueueVersion(db)).toBeGreaterThan(version);
  });

  it("closes a task in review: the open PR is commented on and closed too, unmerged", async () => {
    const t = await open("claude");
    await repo.writeEvent(db, { project: "shut", repo: t.repo, issue: t.issue, pr: 77, lane: "claude", kind: "pr.opened", actor: "runner:w", summary: "PR", url: "https://github.com/acme/shut/pull/77", ts: at(1) });
    expect(await state(t)).toBe("review");
    const { gh, calls, comments } = fakeGitHub();
    const r = await closeTask(db, gh, t.id, "human:kyle");
    expect(r.task.state).toBe("done");
    expect(r.events[0]!.payload.github).toEqual({ closed: true, comment_url: `https://github.com/acme/shut/issues/${t.issue}#issuecomment-1`, pr_closed: 77 });
    expect(comments).toHaveLength(2);
    expect(comments[1]).toBe(`77: ${closeComment("human:kyle", null)}`);
    expect(calls).toContain('PATCH /repos/acme/shut/pulls/77 {"state":"closed"}');
    expect(r.events[0]!.summary).toBe(`Closed #${t.issue} without a merge (was review)`);
  });

  it("releases a live claim so the worker stops, and records which worker held it", async () => {
    const t = await open("codex");
    const { worker: w } = await registerWorker(db, { name: "mini", lanes: ["codex"], version: "0.3.2" });
    const c = await claimNext(db, { workerId: w.id, lanes: ["codex"], leaseMs: 60_000 });
    expect(c.claim?.task_id).toBe(t.id);
    await repo.writeEvent(db, { project: "shut", repo: t.repo, issue: t.issue, lane: "codex", kind: "run.started", actor: "runner:mini", summary: "started", ts: new Date().toISOString() });
    expect(await state(t)).toBe("running");
    const { gh } = fakeGitHub();
    const r = await closeTask(db, gh, t.id, "human:kyle");
    expect(r.task.state).toBe("done");
    expect(r.events[0]!.payload.claim_released).toBe("mini");
    expect(await liveClaim(db, t.id)).toBeUndefined();
  });

  it("is done in relay even when GitHub refuses, and the payload says what failed", async () => {
    const t = await open("claude");
    const { gh } = fakeGitHub({ fail: true });
    const r = await closeTask(db, gh, t.id, "human:kyle");
    expect(r.task.state).toBe("done");
    expect(r.events[0]!.payload.github).toMatchObject({ closed: false });
    expect(String((r.events[0]!.payload.github as { error: string }).error)).toContain("502");
    const r2 = await closeTask(db, undefined, (await open("claude")).id, "human:kyle");
    expect((r2.events[0]!.payload.github as { closed: boolean; error: string }).error).toMatch(/No GitHub credential/);
  });

  it("refuses a done task, a missing one, a bot without tasks:write and an oversize reason", async () => {
    const t = await open("claude");
    await repo.writeEvent(db, { project: "shut", repo: t.repo, issue: t.issue, lane: "claude", kind: "pr.merged", actor: "bot:github", summary: "merged", ts: at(5) });
    await expect(closeTask(db, undefined, t.id, "human:kyle")).rejects.toMatchObject({ name: "TaskCloseError", status: 409 });
    await expect(closeTask(db, undefined, "acme/shut#999999", "human:kyle")).rejects.toMatchObject({ status: 404 });
    const u = await open("claude");
    await expect(closeTask(db, undefined, u.id, "bot:grok", { scopes: ["tasks:read"] })).rejects.toMatchObject({ status: 403 });
    await expect(closeTask(db, undefined, u.id, "bot:grok", { scopes: ["tasks:write"], reason: "x".repeat(2001) })).rejects.toBeInstanceOf(TaskCloseError);
    expect(await state(u)).toBe("queued");
  });
});
