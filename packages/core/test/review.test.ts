import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus, previewMatches } from "../src/db/tasks.ts";
import { getQueueVersion } from "../src/db/queue.ts";
import { compileBrief } from "../src/brief/index.ts";
import { approveTask, requestChanges, reviewNotes, TaskReviewError } from "../src/tasks/review.ts";
import { GitHubError, type GitHubClient, type GitHubIssue, type GitHubPull } from "../src/github/client.ts";

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
});
afterAll(async () => {
  await db.close();
});

const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ev = (kind: string, extra: Partial<repo.EventRow> = {}): repo.EventRow => ({
  id: 0,
  ts: at(0),
  kind,
  actor: "human:kyle",
  project: "demo",
  repo: "acme/demo",
  issue: 42,
  pr: null,
  lane: null,
  model: null,
  subscription: null,
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_write: 0,
  cost_equiv: 0,
  duration_ms: null,
  summary: kind,
  url: null,
  payload: {},
  dedupe_key: null,
  ...extra,
});
const task = { repo: "acme/demo", issue: 42 };

/** A GitHub that remembers what was merged, deleted and commented, and can be told to refuse a merge. */
function fakeGitHub(opts: { refuseMerge?: string; prState?: string; merged?: boolean } = {}) {
  const merged: Array<{ repo: string; number: number; opts: unknown }> = [];
  const deleted: string[] = [];
  const comments: Array<{ repo: string; issue: number; body: string }> = [];
  const gh: GitHubClient = {
    source: "token",
    async createIssue(repo, input): Promise<GitHubIssue> {
      return { number: 1, title: input.title, body: input.body, state: "open", html_url: `https://github.com/${repo}/issues/1`, labels: input.labels ?? [] };
    },
    async addLabels() {},
    async removeLabel() {},
    async getIssue(repo, issue): Promise<GitHubIssue> {
      return { number: issue, title: "t", body: "", state: "open", html_url: `https://github.com/${repo}/issues/${issue}`, labels: [] };
    },
    async request() {
      return {};
    },
    async createComment(repo, issue, body) {
      comments.push({ repo, issue, body });
      return { id: comments.length, html_url: `https://github.com/${repo}/pull/${issue}#issuecomment-${comments.length}` };
    },
    async getPullRequest(repo, number): Promise<GitHubPull> {
      return { number, title: "claude: Add dark mode", state: opts.prState ?? "open", merged: opts.merged ?? false, html_url: `https://github.com/${repo}/pull/${number}`, head_ref: "relay/claude-42", head_sha: "abc1234def", base_ref: "main", user: "relay-agent" };
    },
    async mergePullRequest(repo, number, o) {
      if (opts.refuseMerge) throw new GitHubError(`GitHub PUT /repos/${repo}/pulls/${number}/merge: 405 ${opts.refuseMerge}`, 405);
      merged.push({ repo, number, opts: o });
      return { sha: "fedcba9876543210", merged: true, message: "Pull Request successfully merged" };
    },
    async deleteBranch(_repo, ref) {
      deleted.push(ref);
    },
  };
  return { gh, merged, deleted, comments };
}

async function seedReviewTask(issue: number, lane = "claude", opts: { producer?: string } = {}): Promise<repo.TaskRow> {
  const { task: t } = await repo.createTask(db, { project: "demo", repo: "acme/demo", issue, createdBy: "bot:grok", lane });
  const base = { project: "demo", repo: "acme/demo", issue, lane };
  await repo.writeEvent(db, { ...base, kind: "issue.opened", actor: "bot:grok", summary: `Add dark mode ${issue}`, ts: at(0) });
  await repo.writeEvent(db, { ...base, kind: "run.started", actor: opts.producer ?? "runner:mini", summary: `${lane} on mini`, payload: { branch: `relay/${lane}-${issue}` }, ts: at(1) });
  await repo.writeEvent(db, { ...base, kind: "run.finished", actor: opts.producer ?? "runner:mini", summary: "Added the toggle and the stylesheet", pr: 7, url: "https://github.com/acme/demo/pull/7", payload: { conclusion: "success" }, ts: at(5) });
  await repo.writeEvent(db, { ...base, kind: "step.usage", actor: `agent:${lane}`, summary: "usage", pr: 7, model: "claude-opus-4-1", tokens_in: 1000, tokens_out: 200, cache_read: 5000, cost_equiv: 0.42, duration_ms: 60_000, ts: at(5) });
  await repo.writeEvent(db, { ...base, kind: "pr.opened", actor: opts.producer ? opts.producer.replace(/^runner:/, "agent:") : `agent:${lane}`, summary: `claude: Add dark mode (#${issue})`, pr: 7, url: "https://github.com/acme/demo/pull/7", payload: { branch: `relay/${lane}-${issue}` }, ts: at(6) });
  return t;
}

describe("task view: preview, usage, summary, review", () => {
  it("matches a Vercel preview by PR number and a GitHub deployment by ref; a later push marks it building", () => {
    const base = [
      ev("run.started", { ts: at(1), id: 1, actor: "runner:mini", lane: "claude", payload: { branch: "relay/claude-42" } }),
      ev("run.finished", { ts: at(5), id: 2, actor: "runner:mini", pr: 7, summary: "Added the toggle", payload: { conclusion: "success" } }),
      ev("step.usage", { ts: at(5), id: 3, actor: "agent:claude", pr: 7, model: "claude-opus-4-1", tokens_in: 1000, tokens_out: 200, cache_read: 5000, cost_equiv: 0.42, duration_ms: 60_000 }),
      ev("pr.opened", { ts: at(6), id: 4, actor: "agent:claude", pr: 7, url: "https://github.com/acme/demo/pull/7", payload: { branch: "relay/claude-42" } }),
    ];
    // Vercel: issue unknown, PR known (githubPrId)
    const vercel = ev("preview.ready", { ts: at(8), id: 5, actor: "bot:vercel", issue: null, pr: 7, url: "https://demo-git-relay-claude-42.vercel.app", payload: { ref: "relay/claude-42" } });
    const s1 = deriveTaskStatus(task, [...base, vercel]);
    expect(s1.state).toBe("review");
    expect(s1.preview_url).toBe("https://demo-git-relay-claude-42.vercel.app");
    expect(s1.preview_state).toBe("ready");
    expect(s1.branch).toBe("relay/claude-42");
    expect(s1.run_summary).toBe("Added the toggle");
    expect(s1.usage).toEqual({ runs: 1, tokens_in: 1000, tokens_out: 200, cache_read: 5000, cost_equiv: 0.42, model: "claude-opus-4-1", duration_ms: 60_000 });
    expect(s1.review).toEqual({ decided: null, by: null, at: null, note: null });
    expect(s1.merged_at).toBeNull();
    expect(s1.events).toBe(5);

    // GitHub deployment_status: neither issue nor PR, only the ref; the newer one wins
    const gh = ev("preview.ready", { ts: at(9), id: 6, actor: "bot:vercel", issue: null, pr: null, url: "https://demo-abc.vercel.app", payload: { environment: "Preview", ref: "relay/claude-42" } });
    expect(deriveTaskStatus(task, [...base, vercel, gh]).preview_url).toBe("https://demo-abc.vercel.app");
    // the older branch spelling matches too
    expect(previewMatches(task, ev("preview.ready", { issue: null, payload: { ref: "relay/42-codex" } }), new Set(), null)).toBe(true);
    // a deployment for another branch or PR does not
    expect(previewMatches(task, ev("preview.ready", { issue: null, pr: 99, payload: { ref: "relay/claude-99" } }), new Set([7]), "relay/claude-42")).toBe(false);
    expect(previewMatches(task, ev("preview.ready", { issue: null, payload: { ref: "main" } }), new Set([7]), null)).toBe(false);

    // a failed build after a good one keeps the last good url and says failed
    const failed = ev("preview.failed", { ts: at(10), id: 7, actor: "bot:vercel", issue: null, pr: 7, url: "https://vercel.com/acme/demo/dep", payload: { ref: "relay/claude-42" } });
    const s2 = deriveTaskStatus(task, [...base, vercel, gh, failed]);
    expect(s2.preview_state).toBe("failed");
    expect(s2.preview_url).toBe("https://demo-abc.vercel.app");

    // a new run after the preview: the url is stale until the next deployment
    const rerun = ev("run.finished", { ts: at(12), id: 8, actor: "runner:mini", pr: 7, summary: "Fixed the focus ring", payload: { conclusion: "success" } });
    const s3 = deriveTaskStatus(task, [...base, vercel, gh, rerun]);
    expect(s3.preview_state).toBe("building");
    expect(s3.run_summary).toBe("Fixed the focus ring");
  });

  it("folds task.changes_requested to queued, task.approved to done, and keeps merge_failed in review", () => {
    const base = [ev("run.started", { ts: at(1), id: 1, lane: "claude" }), ev("pr.opened", { ts: at(6), id: 2, pr: 7, actor: "agent:claude" })];
    const back = ev("task.changes_requested", { ts: at(7), id: 3, actor: "human:kyle", pr: 7, payload: { note: "Focus ring missing" } });
    const s1 = deriveTaskStatus(task, [...base, back]);
    expect(s1.state).toBe("queued");
    expect(s1.review).toEqual({ decided: "changes_requested", by: "human:kyle", at: at(7), note: "Focus ring missing" });
    // the next run answers it
    const again = [ev("run.started", { ts: at(8), id: 4, actor: "runner:mini" }), ev("run.finished", { ts: at(9), id: 5, actor: "runner:mini", pr: 7, summary: "Added the ring", payload: { conclusion: "success" } })];
    const s2 = deriveTaskStatus(task, [...base, back, ...again]);
    expect(s2.state).toBe("review");
    expect(s2.review.decided).toBeNull();

    const refused = ev("task.merge_failed", { ts: at(10), id: 6, actor: "human:kyle", pr: 7, payload: { error: "405 Pull Request is not mergeable" } });
    expect(deriveTaskStatus(task, [...base, back, ...again, refused]).state).toBe("review");

    const approved = ev("task.approved", { ts: at(11), id: 7, actor: "human:kyle", pr: 7, payload: { merged: true, merge_sha: "fedcba9" } });
    const s3 = deriveTaskStatus(task, [...base, back, ...again, refused, approved]);
    expect(s3.state).toBe("done");
    expect(s3.merged_at).toBe(at(11));
    expect(s3.review.decided).toBe("approved");
    // GitHub's own pr.merged afterwards agrees and does not move merged_at backwards
    const merged = ev("pr.merged", { ts: at(12), id: 8, pr: 7, actor: "bot:relay" });
    expect(deriveTaskStatus(task, [...base, back, ...again, refused, approved, merged]).merged_at).toBe(at(11));
  });

  it("taskEvents picks up preview rows that arrived without an issue number", async () => {
    const t = await seedReviewTask(142);
    await repo.writeEvent(db, { kind: "preview.ready", actor: "bot:vercel", project: "demo", repo: "acme/demo", issue: null, pr: 7, url: "https://p1.vercel.app", summary: "Preview deployed for #7", payload: { ref: "relay/claude-142" }, ts: at(8) });
    await repo.writeEvent(db, { kind: "preview.ready", actor: "bot:vercel", project: "demo", repo: "acme/demo", issue: null, pr: null, url: "https://p2.vercel.app", summary: "Preview deployed for relay/claude-142", payload: { ref: "relay/claude-142" }, ts: at(9) });
    await repo.writeEvent(db, { kind: "preview.ready", actor: "bot:vercel", project: "demo", repo: "acme/demo", issue: null, pr: null, url: "https://other.vercel.app", summary: "other", payload: { ref: "relay/claude-999" }, ts: at(9) });
    const view = await repo.taskView(db, t);
    expect(view.state).toBe("review");
    expect(view.preview_url).toBe("https://p2.vercel.app");
    expect(view.preview_state).toBe("ready");
    expect(view.events).toBe(7);
  });
});

describe("approveTask", () => {
  it("merges with squash, deletes the branch, writes task.approved and the task is done", async () => {
    const t = await seedReviewTask(201);
    const { gh, merged, deleted } = fakeGitHub();
    const r = await approveTask(db, gh, t.id, "human:kyle");
    expect(merged).toEqual([{ repo: "acme/demo", number: 7, opts: { method: "squash", title: "claude: Add dark mode (#7)", message: "relay: approved by human:kyle\n\nCloses #201", sha: "abc1234def" } }]);
    expect(deleted).toEqual(["relay/claude-42"]);
    expect(r.events.map((e) => e.kind)).toEqual(["task.approved"]);
    expect(r.events[0]).toMatchObject({ actor: "human:kyle", pr: 7, issue: 201, url: "https://github.com/acme/demo/pull/7" });
    expect(r.events[0]?.payload).toMatchObject({ merged: true, merge_sha: "fedcba9876543210", branch: "relay/claude-42", branch_deleted: true });
    expect(r.task.state).toBe("done");
    expect(r.task.merged_at).toBe(r.events[0]?.ts);
    expect(r.task.review.decided).toBe("approved");
    // a second approval is refused: the task is done, not in review
    await expect(approveTask(db, gh, t.id, "human:kyle")).rejects.toMatchObject({ status: 409 });
  });

  it("records task.merge_failed with GitHub's message when the merge is refused, and the task stays in review", async () => {
    const t = await seedReviewTask(202);
    const { gh, deleted } = fakeGitHub({ refuseMerge: "Pull Request is not mergeable" });
    await expect(approveTask(db, gh, t.id, "human:kyle")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("not mergeable") });
    expect(deleted).toEqual([]);
    const view = await repo.taskView(db, t);
    expect(view.state).toBe("review");
    expect(view.last_kind).toBe("task.merge_failed");
    const events = await repo.taskEvents(db, t);
    expect(events.at(-1)?.payload).toMatchObject({ error: expect.stringContaining("405"), status: 405 });
  });

  it("refuses a task that is not in review, an unknown task, and a missing GitHub credential", async () => {
    const { task: queued } = await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 203, createdBy: "human:kyle", lane: "claude" });
    const { gh } = fakeGitHub();
    await expect(approveTask(db, gh, queued.id, "human:kyle")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("queued") });
    await expect(approveTask(db, gh, "acme/demo#9999", "human:kyle")).rejects.toMatchObject({ status: 404 });
    const t = await seedReviewTask(204);
    await expect(approveTask(db, undefined, t.id, "human:kyle")).rejects.toMatchObject({ status: 503 });
    expect((await repo.taskView(db, t)).state).toBe("review");
  });

  it("a bot needs tasks:write and never approves a PR its own lane produced; a person is unrestricted", async () => {
    const t = await seedReviewTask(205, "codex", { producer: "runner:codex-bot" });
    const { gh, merged } = fakeGitHub();
    const e1 = await approveTask(db, gh, t.id, "bot:grok", { scopes: ["tasks:read"] }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(TaskReviewError);
    expect(e1).toMatchObject({ status: 403, message: expect.stringMatching(/lacks tasks:write.*signed-in person/) });
    // same name as the run.started / pr.opened actor: self-approval
    const e2 = await approveTask(db, gh, t.id, "bot:codex-bot", { scopes: ["tasks:write"] }).catch((e: unknown) => e);
    expect(e2).toMatchObject({ status: 403, message: expect.stringContaining("its own work") });
    expect(merged).toEqual([]);
    // a different bot with tasks:write may
    const ok = await approveTask(db, gh, t.id, "bot:woodhouse", { scopes: ["tasks:write"] });
    expect(ok.task.state).toBe("done");
    expect(ok.events[0]?.actor).toBe("bot:woodhouse");
  });
});

describe("requestChanges", () => {
  it("comments on the PR, writes task.changes_requested, queues the task, rings the doorbell, and the brief carries the note", async () => {
    const t = await seedReviewTask(301);
    const { gh, comments } = fakeGitHub();
    const before = await getQueueVersion(db);
    const r = await requestChanges(db, gh, t.id, "human:kyle", "The toggle has no focus ring.\nMatch the one on /settings.");
    expect(comments).toEqual([{ repo: "acme/demo", issue: 7, body: "relay: changes requested by human:kyle:\n\nThe toggle has no focus ring.\nMatch the one on /settings.\n" }]);
    expect(r.events.map((e) => e.kind)).toEqual(["task.changes_requested"]);
    expect(r.events[0]).toMatchObject({ actor: "human:kyle", pr: 7, issue: 301, url: "https://github.com/acme/demo/pull/7#issuecomment-1" });
    expect(r.events[0]?.payload).toMatchObject({ note: "The toggle has no focus ring.\nMatch the one on /settings.", branch: "relay/claude-301" });
    expect(r.task.state).toBe("queued");
    expect(r.task.review).toMatchObject({ decided: "changes_requested", by: "human:kyle", note: "The toggle has no focus ring.\nMatch the one on /settings." });
    expect(await getQueueVersion(db)).toBeGreaterThan(before);

    expect(await reviewNotes(db, t)).toMatchObject([{ by: "human:kyle", pr: 7, note: "The toggle has no focus ring.\nMatch the one on /settings." }]);
    const brief = await compileBrief(db, { project: "demo", intent: "implement issue #301: Add dark mode", issue: { number: 301, title: "Add dark mode 301" }, lane: "claude", maxTokens: 3000 });
    expect(brief.sections.map((s) => s.name)).toContain("review");
    expect(brief.text.startsWith("## Review feedback")).toBe(true);
    expect(brief.text).toContain("human:kyle on PR #7");
    expect(brief.text).toContain("The toggle has no focus ring.");
    expect(brief.text).toContain("  Match the one on /settings.");
    // another issue's brief does not carry it
    const other = await compileBrief(db, { project: "demo", intent: "x", issue: { number: 302, title: "other" }, maxTokens: 3000 });
    expect(other.omitted).toContain("review");

    // a changes-requested task is queued again and cannot be sent back twice
    await expect(requestChanges(db, gh, t.id, "human:kyle", "again")).rejects.toMatchObject({ status: 409 });
  });

  it("needs a note and the same guard rails as approve", async () => {
    const t = await seedReviewTask(303, "claude", { producer: "runner:claude-bot" });
    const { gh, comments } = fakeGitHub();
    await expect(requestChanges(db, gh, t.id, "human:kyle", "   ")).rejects.toMatchObject({ status: 400 });
    await expect(requestChanges(db, gh, t.id, "bot:claude-bot", "nope", { scopes: ["tasks:write"] })).rejects.toMatchObject({ status: 403 });
    await expect(requestChanges(db, gh, t.id, "bot:grok", "nope", { scopes: ["events:write"] })).rejects.toMatchObject({ status: 403 });
    expect(comments).toEqual([]);
    const ok = await requestChanges(db, gh, t.id, "bot:grok", "Use the shared Button.", { scopes: ["tasks:write"] });
    expect(ok.task.state).toBe("queued");
    expect(comments[0]?.body.startsWith("relay: changes requested by bot:grok:")).toBe(true);
  });
});
