/**
 * Requeue (tasks/requeue.ts): a task comes back to the queue from any state but done, its lane and the issue's
 * agent:* label move together, a live claim is released, and the doorbell counts it again.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus } from "../src/db/tasks.ts";
import { getQueueVersion } from "../src/db/queue.ts";
import { requeueTask, TaskRequeueError } from "../src/tasks/requeue.ts";
import { GitHubError, type GitHubClient, type GitHubIssue } from "../src/github/client.ts";

let db: Db;
let issue = 100;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
});
afterAll(async () => {
  await db.close();
});

const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** A GitHub that remembers label changes and can be told what an issue carries, or to fail. */
function fakeGitHub(opts: { labels?: string[]; fail?: boolean } = {}) {
  const removed: string[] = [];
  const added: string[] = [];
  const ensured: string[] = [];
  const boom = () => {
    throw new GitHubError("GitHub DELETE /repos/acme/demo/issues/1/labels/x: 502 bad gateway", 502);
  };
  const gh: GitHubClient = {
    source: "token",
    async createIssue(repo, input): Promise<GitHubIssue> {
      return { number: 1, title: input.title, body: input.body, state: "open", html_url: `https://github.com/${repo}/issues/1`, labels: input.labels ?? [] };
    },
    async addLabels(_repo, _issue, labels) {
      if (opts.fail) boom();
      added.push(...labels);
    },
    async removeLabel(_repo, _issue, label) {
      if (opts.fail) boom();
      removed.push(label);
    },
    async ensureLabel(_repo, label) {
      if (opts.fail) boom();
      ensured.push(`${label.name} ${label.color} ${label.description}`);
    },
    async getIssue(repo, n): Promise<GitHubIssue> {
      if (opts.fail) boom();
      return { number: n, title: "t", body: "", state: "open", html_url: `https://github.com/${repo}/issues/${n}`, labels: opts.labels ?? [] };
    },
    async request() {
      return {};
    },
    async createComment() {
      return { id: 1, html_url: "" };
    },
    async getPullRequest() {
      throw new Error("unused");
    },
    async mergePullRequest() {
      throw new Error("unused");
    },
    async deleteBranch() {},
  };
  return { gh, removed, added, ensured };
}

const open = async (lane: string) => (await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: ++issue, createdBy: "bot:grok", lane })).task;
const state = async (t: repo.TaskRow) => (await repo.taskState(db, t)).state;

describe("requeueTask", () => {
  it("re-lanes a dispatched cloud task onto a worker lane: the row, the labels and the state move, and the doorbell counts it", async () => {
    const t = await open("claude-cloud");
    await repo.writeEvent(db, { project: "demo", repo: t.repo, issue: t.issue, lane: "claude-cloud", kind: "run.dispatched", actor: "bot:grok", summary: "Dispatched", ts: at(1) });
    expect(await state(t)).toBe("running");
    expect((await repo.doorbell(db, { lanes: ["claude"] })).queued).toBe(0);
    const before = await getQueueVersion(db);
    const { gh, removed, added } = fakeGitHub({ labels: ["agent:claude-cloud", "priority:high"] });

    const r = await requeueTask(db, gh, t.id, "human:kyle", { lane: "claude", reason: "the cloud lane is not wired" });
    expect(r.task.state).toBe("queued");
    expect(r.task.lane).toBe("claude");
    expect(r.task.runner).toBeNull();
    expect((await repo.getTask(db, t.id))?.lane).toBe("claude");
    expect(removed).toEqual(["agent:claude-cloud"]);
    expect(added).toEqual(["agent:claude"]);
    expect(r.events.map((e) => e.kind)).toEqual(["task.requeued"]);
    const ev = r.events[0]!;
    expect(ev.actor).toBe("human:kyle");
    expect(ev.lane).toBe("claude");
    expect(ev.summary).toBe("Requeued #101 on the claude lane (was claude-cloud), was running: the cloud lane is not wired");
    expect(ev.payload).toMatchObject({ previous_state: "running", previous_lane: "claude-cloud", lane: "claude", reason: "the cloud lane is not wired", github: { relabelled: true, removed: ["agent:claude-cloud"], added: "agent:claude" }, claim_released: null });
    expect(await getQueueVersion(db)).toBeGreaterThan(before);
    // the doorbell for a claude worker now sees it, and a claude worker can claim it
    expect((await repo.doorbell(db, { lanes: ["claude"] })).queued).toBe(1);
    expect((await repo.doorbell(db, { lanes: ["codex"] })).queued).toBe(0);
    const { worker } = await repo.registerWorker(db, { name: "w-cloud", lanes: ["claude"] });
    const got = await repo.claimNext(db, { workerId: worker.id, lanes: ["claude"] });
    expect(got?.task.id).toBe(t.id);
    expect(got?.task.lane).toBe("claude");
    await repo.releaseClaim(db, t.id, worker.id, "released");
  });

  it("releases a live claim on a running task so a worker can claim it again", async () => {
    const t = await open("codex");
    const { worker } = await repo.registerWorker(db, { name: "w-run", lanes: ["codex"] });
    const got = await repo.claimNext(db, { workerId: worker.id, lanes: ["codex"] });
    expect(got?.task.id).toBe(t.id);
    await repo.writeEvent(db, { project: "demo", repo: t.repo, issue: t.issue, lane: "codex", kind: "run.started", actor: "runner:w-run", summary: "codex on w-run", payload: { branch: `relay/codex-${t.issue}` } });
    expect(await state(t)).toBe("running");
    expect(await repo.liveClaim(db, t.id)).toBeDefined();

    const { gh, removed, added } = fakeGitHub({ labels: ["agent:codex"] });
    const r = await requeueTask(db, gh, t.id, "human:kyle", { reason: "hung" });
    expect(r.task.state).toBe("queued");
    expect(r.task.lane).toBe("codex");
    expect(await repo.liveClaim(db, t.id)).toBeUndefined();
    const claims = await repo.listClaims(db, { taskId: t.id });
    expect(claims[0]).toMatchObject({ outcome: "released" });
    expect(claims[0]?.released_at).toBeTruthy();
    expect(r.events[0]?.payload).toMatchObject({ previous_state: "running", previous_lane: "codex", lane: "codex", claim_released: "w-run", branch: `relay/codex-${t.issue}` });
    // the lane did not change: the issue already carries its label, so nothing moved on GitHub
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
    // the same worker claims it again and starts over
    const again = await repo.claimNext(db, { workerId: worker.id, lanes: ["codex"] });
    expect(again?.task.id).toBe(t.id);
    expect(await state(t)).toBe("claimed");
    await repo.releaseClaim(db, t.id, worker.id, "released");
  });

  it("brings a failed task and a task in review back to the queue; the fold is queued until the next run", async () => {
    const failed = await open("claude");
    const base = (t: repo.TaskRow, lane: string) => ({ project: "demo", repo: t.repo, issue: t.issue, lane });
    await repo.writeEvent(db, { ...base(failed, "claude"), kind: "run.started", actor: "runner:w", summary: "x", ts: at(1) });
    await repo.writeEvent(db, { ...base(failed, "claude"), kind: "run.failed", actor: "runner:w", summary: "timed out", ts: at(5) });
    expect(await state(failed)).toBe("failed");
    expect((await requeueTask(db, fakeGitHub({ labels: ["agent:claude"] }).gh, failed.id, "human:kyle")).task.state).toBe("queued");

    const review = await open("claude");
    await repo.writeEvent(db, { ...base(review, "claude"), kind: "run.started", actor: "runner:w", summary: "x", ts: at(1) });
    await repo.writeEvent(db, { ...base(review, "claude"), kind: "pr.opened", actor: "agent:claude", summary: "claude: thing", pr: 9, url: "https://github.com/acme/demo/pull/9", ts: at(6) });
    expect(await state(review)).toBe("review");
    const r = await requeueTask(db, fakeGitHub({ labels: ["agent:claude"] }).gh, review.id, "human:kyle", { lane: "grok" });
    expect(r.task.state).toBe("queued");
    expect(r.task.lane).toBe("grok");
    expect(r.task.pr).toBe(9); // the PR is still the task's; the next run pushes to the same branch
    expect(r.events[0]?.pr).toBe(9);
    // the next run makes it running, then review again
    const events = await repo.taskEvents(db, review);
    // task.requeued carries the database clock, so the next run must be stamped after it
    const next = [...events, { ...events.at(-1)!, id: 999, kind: "run.started", ts: new Date(Date.now() + 60_000).toISOString(), actor: "runner:g", payload: {} }];
    expect(deriveTaskStatus(review, next).state).toBe("running");
  });

  it("refuses a done task, an unknown task, a bad lane and a bot without tasks:write", async () => {
    const t = await open("claude");
    await repo.writeEvent(db, { project: "demo", repo: t.repo, issue: t.issue, lane: "claude", kind: "pr.merged", actor: "human:kyle", summary: "merged", pr: 3, ts: at(9) });
    const { gh } = fakeGitHub({ labels: ["agent:claude"] });
    await expect(requeueTask(db, gh, t.id, "human:kyle")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/done/) } satisfies Partial<TaskRequeueError>);
    await expect(requeueTask(db, gh, "acme/demo#9999", "human:kyle")).rejects.toMatchObject({ status: 404 });
    const live = await open("claude");
    await expect(requeueTask(db, gh, live.id, "human:kyle", { lane: "gemini" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no worker serves lane 'gemini'; lanes with a worker: none; built-in: claude, codex, grok, nodes/) });
    await expect(requeueTask(db, gh, live.id, "human:kyle", { lane: "Gemini" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/lane 'Gemini' is not a lane name/) });
    await expect(requeueTask(db, gh, live.id, "bot:grok", { lane: "codex", scopes: ["tasks:read"] })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/tasks:write/) });
    expect((await repo.getTask(db, live.id))?.lane).toBe("claude");
    // with the scope, or unrestricted (a local user), it goes through
    expect((await requeueTask(db, gh, live.id, "bot:grok", { lane: "codex", scopes: ["tasks:write"] })).task.lane).toBe("codex");
    expect((await requeueTask(db, gh, live.id, "bot:grok", { lane: "claude" })).task.lane).toBe("claude");
  });

  it("records a GitHub failure in the payload and queues anyway; no credential is recorded the same way", async () => {
    const t = await open("claude-cloud");
    await repo.writeEvent(db, { project: "demo", repo: t.repo, issue: t.issue, lane: "claude-cloud", kind: "run.dispatched", actor: "bot:grok", summary: "Dispatched", ts: at(1) });
    const r = await requeueTask(db, fakeGitHub({ fail: true }).gh, t.id, "human:kyle", { lane: "claude" });
    expect(r.task.state).toBe("queued");
    expect(r.task.lane).toBe("claude");
    expect(r.events[0]?.payload.github).toMatchObject({ relabelled: false, error: expect.stringMatching(/502 bad gateway/) });

    const t2 = await open("codex-cloud");
    const r2 = await requeueTask(db, undefined, t2.id, "human:kyle", { lane: "codex" });
    expect(r2.task.state).toBe("queued");
    expect(r2.task.lane).toBe("codex");
    expect(r2.events[0]?.payload.github).toMatchObject({ relabelled: false, error: expect.stringMatching(/No GitHub credential/) });
  });
});

describe("requeue onto a registered worker's lane", () => {
  it("is refused until a worker serves the lane, then moves the task and makes the label", async () => {
    const t = await open("claude");
    const { gh, added, removed, ensured } = fakeGitHub({ labels: ["agent:claude"] });
    await expect(requeueTask(db, gh, t.id, "human:kyle", { lane: "laser" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no worker serves lane 'laser'/) });
    expect((await repo.getTask(db, t.id))?.lane).toBe("claude");

    await repo.registerWorker(db, { name: "cutter", lanes: ["laser"] });
    const r = await requeueTask(db, gh, t.id, "human:kyle", { lane: "laser", reason: "the hoop is busy" });
    expect(r.task.lane).toBe("laser");
    expect(await state(await repo.getTask(db, t.id) as repo.TaskRow)).toBe("queued");
    expect(removed).toEqual(["agent:claude"]);
    expect(added).toEqual(["agent:laser"]);
    expect(ensured).toEqual(["agent:laser 8A2BE2 relay: served by the laser worker"]);
    // and back to a built-in lane: no ensureLabel, relay link installed that label
    await requeueTask(db, gh, t.id, "human:kyle", { lane: "codex" });
    expect(ensured.length).toBe(1);
    expect(added).toEqual(["agent:laser", "agent:codex"]);
  });
});
