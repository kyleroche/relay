import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus } from "../src/db/tasks.ts";
import { isLaneName, knownLanes, laneUnservedProblem, openTask, TaskCreateError, taskMarker } from "../src/tasks/create.ts";
import type { GitHubClient, GitHubIssue } from "../src/github/client.ts";

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
  await repo.upsertProject(db, { slug: "norepo", path: "/tmp/norepo" });
});
afterAll(async () => {
  await db.close();
});

const ev = (kind: string, extra: Partial<repo.EventRow> = {}): repo.EventRow => ({
  id: 0,
  ts: "2026-10-16T10:00:00.000Z",
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
const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, "0")}:00.000Z`;
const task = { repo: "acme/demo", issue: 42 };

describe("task state derivation", () => {
  it("is queued with no events", () => {
    const s = deriveTaskStatus(task, []);
    expect(s.state).toBe("queued");
    expect(s.issue_url).toBe("https://github.com/acme/demo/issues/42");
    expect(s.events).toBe(0);
  });

  it("follows the documented table", () => {
    const table: Array<[string, Partial<repo.EventRow>, string]> = [
      ["issue.labeled", { lane: "claude" }, "queued"],
      ["run.started", { actor: "runner:mini" }, "running"],
      ["pr.opened", { pr: 7, url: "https://github.com/acme/demo/pull/7", actor: "agent:claude" }, "review"],
      ["pr.merged", { pr: 7 }, "done"],
    ];
    const events: repo.EventRow[] = [];
    let i = 0;
    for (const [kind, extra, expected] of table) {
      events.push(ev(kind, { ...extra, ts: at(i++), id: i }));
      expect(deriveTaskStatus(task, events).state).toBe(expected);
    }
    const final = deriveTaskStatus(task, events);
    expect(final.runner).toBe("runner:mini");
    expect(final.lane).toBe("claude");
    expect(final.pr).toBe(7);
    expect(final.pr_url).toBe("https://github.com/acme/demo/pull/7");
    expect(final.last_kind).toBe("pr.merged");
  });

  it("run.failed and failing conclusions mean failed; a new label re-queues", () => {
    expect(deriveTaskStatus(task, [ev("issue.labeled", { ts: at(0) }), ev("run.started", { ts: at(1) }), ev("run.failed", { ts: at(2) })]).state).toBe("failed");
    expect(deriveTaskStatus(task, [ev("run.started", { ts: at(1) }), ev("run.finished", { ts: at(2), payload: { conclusion: "failure" } })]).state).toBe("failed");
    expect(deriveTaskStatus(task, [ev("run.started", { ts: at(1) }), ev("run.finished", { ts: at(2), payload: { conclusion: "success" } })]).state).toBe("review");
    expect(deriveTaskStatus(task, [ev("run.failed", { ts: at(1) }), ev("issue.labeled", { ts: at(2) })]).state).toBe("queued");
    expect(deriveTaskStatus(task, [ev("pr.opened", { ts: at(1), pr: 3 }), ev("pr.closed", { ts: at(2), pr: 3 })]).state).toBe("queued");
    expect(deriveTaskStatus(task, [ev("pr.opened", { ts: at(1), pr: 3 }), ev("issue.closed", { ts: at(2) })]).state).toBe("done");
  });

  it("orders by timestamp, not by insertion", () => {
    const out = deriveTaskStatus(task, [ev("pr.merged", { ts: at(5), pr: 1 }), ev("run.started", { ts: at(1) })]);
    expect(out.state).toBe("done");
    expect(out.summary).toBe("pr.merged");
  });

  it("the asset path: asset.uploaded is review with the asset, a rejection queues it with the note, a new version answers it, an approval is done", () => {
    const uploaded = (id: string, version: number, minute: number) => ev("asset.uploaded", { ts: at(minute), actor: "runner:studio", payload: { asset_id: id, kind: "video", mime: "video/mp4", version } });
    const reviewed = (id: string, decision: string, minute: number, note: string | null = null) => ev("asset.reviewed", { ts: at(minute), actor: "human:maya", payload: { asset_id: id, decision, note, version: 1 } });
    const events = [ev("issue.labeled", { ts: at(0), lane: "claude" }), ev("run.started", { ts: at(1), actor: "runner:studio" })];
    expect(deriveTaskStatus(task, events).state).toBe("running");
    expect(deriveTaskStatus(task, events).asset).toBeNull();

    events.push(uploaded("A1", 1, 2));
    const s1 = deriveTaskStatus(task, events);
    expect(s1.state).toBe("review");
    expect(s1.asset).toEqual({ id: "A1", kind: "video", version: 1 });
    expect(s1.pr).toBeNull();
    // the run that produced it finishes afterwards: still in review
    events.push(ev("run.finished", { ts: at(3), actor: "runner:studio", payload: { conclusion: "success" } }));
    expect(deriveTaskStatus(task, events).state).toBe("review");

    events.push(reviewed("A1", "rejected", 4, "Cut the first two seconds."));
    const s2 = deriveTaskStatus(task, events);
    expect(s2.state).toBe("queued");
    expect(s2.review).toEqual({ decided: "changes_requested", by: "human:maya", at: at(4), note: "Cut the first two seconds." });
    expect(s2.asset).toEqual({ id: "A1", kind: "video", version: 1 });

    events.push(ev("run.started", { ts: at(5), actor: "runner:studio" }), uploaded("A2", 2, 6));
    const s3 = deriveTaskStatus(task, events);
    expect(s3.state).toBe("review");
    expect(s3.asset).toEqual({ id: "A2", kind: "video", version: 2 });
    expect(s3.review.decided).toBeNull(); // the new version answers the rejection

    events.push(reviewed("A2", "approved", 7));
    const s4 = deriveTaskStatus(task, events);
    expect(s4.state).toBe("done");
    expect(s4.review).toMatchObject({ decided: "approved", by: "human:maya" });
    expect(s4.merged_at).toBeNull(); // nothing merged: the deliverable was an asset
    // GitHub's issue.closed, written when the site closed the issue, agrees
    events.push(ev("issue.closed", { ts: at(8) }));
    expect(deriveTaskStatus(task, events).state).toBe("done");
    // a payload without an id (an older writer) still moves the state
    expect(deriveTaskStatus(task, [ev("asset.uploaded", { ts: at(1), payload: {} })])).toMatchObject({ state: "review", asset: null });
  });
});

function fakeGitHub(): GitHubClient & { created: Array<{ repo: string; title: string; body: string; labels: string[] }>; labelled: string[]; ensured: Array<{ repo: string; name: string; color: string; description: string }> } {
  let n = 100;
  const created: Array<{ repo: string; title: string; body: string; labels: string[] }> = [];
  const labelled: string[] = [];
  const ensured: Array<{ repo: string; name: string; color: string; description: string }> = [];
  return {
    source: "token",
    created,
    labelled,
    ensured,
    async ensureLabel(repo, label) {
      ensured.push({ repo, ...label });
    },
    async createIssue(repo, input): Promise<GitHubIssue> {
      created.push({ repo, title: input.title, body: input.body, labels: input.labels ?? [] });
      n++;
      return { number: n, title: input.title, body: input.body, state: "open", html_url: `https://github.com/${repo}/issues/${n}`, labels: input.labels ?? [] };
    },
    async addLabels(_repo, issue, labels) {
      labelled.push(`${issue}:${labels.join(",")}`);
    },
    async removeLabel() {},
    async getIssue(repo, issue): Promise<GitHubIssue> {
      return { number: issue, title: "t", body: "", state: "open", html_url: `https://github.com/${repo}/issues/${issue}`, labels: [] };
    },
    async request() {
      return {};
    },
    async createComment(repo, issue) {
      return { id: 1, html_url: `https://github.com/${repo}/issues/${issue}#issuecomment-1` };
    },
  };
}

describe("openTask", () => {
  it("adds production:<slug> only when the project's repository is shared by another project", async () => {
    const gh = fakeGitHub();
    await repo.upsertProject(db, { slug: "nightfall", repo: "acme/productions" });
    const solo = await openTask(db, gh, { project: "nightfall", title: "Teaser cut", lane: "claude", actor: "human:kyle" });
    expect(gh.created.at(-1)?.labels).toEqual(["agent:claude"]);
    expect(solo.task.project).toBe("nightfall");

    await repo.upsertProject(db, { slug: "daybreak", repo: "acme/productions" });
    const shared = await openTask(db, gh, { project: "daybreak", title: "Opening shot", lane: "claude", priority: "high", actor: "human:kyle" });
    expect(gh.created.at(-1)?.labels).toEqual(["agent:claude", "priority:high", "production:daybreak"]);
    expect(shared.events[0]?.payload.labels).toContain("production:daybreak");
    expect(shared.task.repo).toBe("acme/productions");
    // a code repo of its own stays as it was
    await openTask(db, gh, { project: "demo", title: "Plain", lane: "codex", actor: "human:kyle" });
    expect(gh.created.at(-1)?.labels).toEqual(["agent:codex"]);
  });

  it("opens the issue with the lane label, records the task and both events, and is idempotent on the key", async () => {
    const gh = fakeGitHub();
    const r1 = await openTask(db, gh, { project: "demo", title: "Add dark mode", body: "Please.", lane: "codex", priority: "high", idempotency_key: "grok-1", actor: "bot:grok" });
    expect(r1.created).toBe(true);
    expect(r1.task_id).toBe("acme/demo#101");
    expect(r1.issue_url).toBe("https://github.com/acme/demo/issues/101");
    expect(r1.task.state).toBe("queued");
    expect(gh.created[0]?.labels).toEqual(["agent:codex", "priority:high"]);
    expect(gh.created[0]?.body).toContain(taskMarker("grok-1"));
    expect(r1.events.map((e) => e.kind)).toEqual(["issue.opened", "task.created"]);
    expect(r1.events[0]?.actor).toBe("bot:grok");

    const r2 = await openTask(db, gh, { project: "demo", title: "Add dark mode (again)", lane: "codex", idempotency_key: "grok-1", actor: "bot:grok" });
    expect(r2.created).toBe(false);
    expect(r2.task_id).toBe("acme/demo#101");
    expect(gh.created.length).toBe(1);
    expect(r2.events).toEqual([]);

    const view = await repo.taskView(db, (await repo.getTask(db, "acme/demo#101"))!);
    expect(view.state).toBe("queued");
    expect(view.events).toBe(2);
    expect(view.lane).toBe("codex");

    // the webhook's run.started lands later with the repo and issue; the state follows
    await repo.writeEvent(db, { kind: "run.started", actor: "runner:mini", repo: "acme/demo", issue: 101, lane: "codex", summary: "codex on mini" });
    expect((await repo.listTaskViews(db, { project: "demo" }))[0]?.state).toBe("running");
    expect((await repo.listTaskViews(db, { state: "done" })).length).toBe(0);
  });

  it("refuses unknown projects, projects without a repo, bad lanes and missing GitHub access", async () => {
    const gh = fakeGitHub();
    await expect(openTask(db, gh, { project: "ghost", title: "x", lane: "claude", actor: "bot:a" })).rejects.toMatchObject({ status: 404 });
    await expect(openTask(db, gh, { project: "norepo", title: "x", lane: "claude", actor: "bot:a" })).rejects.toBeInstanceOf(TaskCreateError);
    // a well-formed name nobody serves, and a malformed one
    await expect(openTask(db, gh, { project: "demo", title: "x", lane: "gemini", actor: "bot:a" })).rejects.toThrow(/no worker serves lane 'gemini'/);
    await expect(openTask(db, gh, { project: "demo", title: "x", lane: "Gemini!", actor: "bot:a" })).rejects.toThrow(/lane 'Gemini!' is not a lane name/);
    expect(gh.created.length).toBe(0);
    await expect(openTask(db, undefined, { project: "demo", title: "x", lane: "claude", actor: "bot:a" })).rejects.toMatchObject({ status: 503 });
  });

  it("createTask is one row per issue", async () => {
    const a = await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 500, createdBy: "human:kyle" });
    const b = await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 500, createdBy: "human:kyle" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe("acme/demo#500");
  });
});

describe("the lane registry", () => {
  // a repository of its own: the fake GitHub numbers issues from 100 in every test, and task rows are one per issue
  beforeAll(() => repo.upsertProject(db, { slug: "hoop", repo: "acme/hoop", path: "/tmp/hoop" }));

  it("isLaneName: a lowercase word of letters, digits and dashes, 1 to 32 characters, starting with a letter", () => {
    for (const ok of ["claude", "codex", "grok", "nodes", "claude-cloud", "embroidery", "laser-cut", "a", "x1", "a".repeat(32)]) expect(isLaneName(ok)).toBe(true);
    for (const bad of ["", "Claude", "1lane", "-lane", "lane_1", "lane cut", "agent:claude", "a".repeat(33), "laser.cut", "émbroidery"]) expect(isLaneName(bad)).toBe(false);
  });

  it("a task on a lane opens only once a worker has registered it; the refusal names the lanes that have one", async () => {
    const gh = fakeGitHub();
    expect((await knownLanes(db)).registered).toEqual([]);
    const before = await laneUnservedProblem(db, "embroidery");
    expect(before).toBe("no worker serves lane 'embroidery'; lanes with a worker: none; built-in: claude, codex, grok, nodes; cloud: claude-cloud, codex-cloud");
    await expect(openTask(db, gh, { project: "hoop", title: "Hoop the logo", lane: "embroidery", actor: "bot:digitizer" })).rejects.toMatchObject({ status: 400, message: before });
    expect(gh.created.length).toBe(0);
    expect(gh.ensured.length).toBe(0);

    // the embroidery app registers as a worker serving its lane (later also laser)
    await repo.registerWorker(db, { name: "digitizer", lanes: ["embroidery"] });
    expect(await laneUnservedProblem(db, "embroidery")).toBeUndefined();
    expect(await laneUnservedProblem(db, "laser")).toBe("no worker serves lane 'laser'; lanes with a worker: embroidery; built-in: claude, codex, grok, nodes; cloud: claude-cloud, codex-cloud");
    const r = await openTask(db, gh, { project: "hoop", title: "Hoop the logo", lane: "embroidery", actor: "bot:digitizer" });
    expect(r.created).toBe(true);
    expect(r.task.lane).toBe("embroidery");
    expect(gh.created.at(-1)?.labels).toEqual(["agent:embroidery"]);
    // the label is made with relay's colour before the issue carries it; relay link never installs it
    expect(gh.ensured).toEqual([{ repo: "acme/hoop", name: "agent:embroidery", color: "8A2BE2", description: "relay: served by the embroidery worker" }]);

    // built-in and cloud lanes need no worker and get no ensureLabel (relay link installed those labels)
    await openTask(db, gh, { project: "hoop", title: "Plain", lane: "claude", actor: "human:kyle" });
    await openTask(db, gh, { project: "hoop", title: "Cloud", lane: "codex-cloud", actor: "human:kyle" });
    expect(gh.ensured.length).toBe(1);

    await repo.registerWorker(db, { name: "digitizer", lanes: ["embroidery", "laser"] });
    const known = await knownLanes(db);
    expect(known.builtin).toEqual(["claude", "codex", "grok", "nodes"]);
    expect(known.cloud).toEqual(["claude-cloud", "codex-cloud"]);
    expect(known.registered).toEqual(["embroidery", "laser"]);
    // a worker that also serves a built-in lane adds nothing to the registered list
    await repo.registerWorker(db, { name: "mini", lanes: ["claude", "codex"] });
    expect((await knownLanes(db)).registered).toEqual(["embroidery", "laser"]);
  });

  it("a GitHub client without ensureLabel, or one whose ensureLabel fails, still opens the task", async () => {
    await repo.upsertProject(db, { slug: "bare", repo: "acme/bare", path: "/tmp/bare" }); // its own issue numbers again
    const gh = fakeGitHub();
    const bare: GitHubClient = { ...gh };
    delete (bare as Partial<GitHubClient>).ensureLabel;
    expect((await openTask(db, bare, { project: "bare", title: "Bare", lane: "embroidery", actor: "bot:digitizer" })).task.lane).toBe("embroidery");
    const failing: GitHubClient = {
      ...gh,
      async ensureLabel() {
        throw new Error("labels: 403");
      },
    };
    expect((await openTask(db, failing, { project: "bare", title: "Failing", lane: "embroidery", actor: "bot:digitizer" })).task.lane).toBe("embroidery");
  });
});

describe("openTask with a relay-job block", () => {
  const fence = (inner: string) => `Digitize the logo for the left chest.\n\n\`\`\`relay-job\n${inner}\n\`\`\`\n`;
  it("refuses a block that does not parse, or names an asset that is missing or on another project", async () => {
    const gh = fakeGitHub();
    await repo.upsertProject(db, { slug: "stitch", repo: "acme/stitch" });
    await repo.upsertProject(db, { slug: "other", repo: "acme/other" });
    await repo.registerWorker(db, { name: "stitcher", lanes: ["digitize"] });
    await expect(openTask(db, gh, { project: "stitch", title: "Logo", lane: "digitize", body: fence("inputs: [01JMISSING]"), actor: "human:kyle" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/relay-job manifest: input asset 01JMISSING does not exist/) });
    await repo.createAsset(db, { id: "01JELSE", project: "other", title: "elsewhere", kind: "image", mime: "image/png", size: 3, sha256: "e".repeat(64), storageKey: "other/01JELSE/a.png", createdBy: "human:kyle" });
    await expect(openTask(db, gh, { project: "stitch", title: "Logo", lane: "digitize", body: fence("inputs: [01JELSE]"), actor: "human:kyle" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/belongs to project 'other'/) });
    await expect(openTask(db, gh, { project: "stitch", title: "Logo", lane: "digitize", body: fence("wrong: 1"), actor: "human:kyle" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/relay-job manifest:/) });
    expect(gh.created.some((c) => c.title === "Logo")).toBe(false);
  });
  it("opens the issue when the block parses and its inputs are the project's own", async () => {
    const gh = fakeGitHub();
    await repo.createAsset(db, { id: "01JLOGO", project: "stitch", title: "logo", kind: "image", mime: "image/png", size: 3, sha256: "a".repeat(64), storageKey: "stitch/01JLOGO/logo.png", createdBy: "human:kyle" });
    const r = await openTask(db, gh, { project: "stitch", title: "Logo", lane: "digitize", body: fence("inputs:\n  - asset: 01JLOGO\n    as: artwork\nparams:\n  hoop: 100x100\noutputs: [stitch-file]"), actor: "human:kyle" });
    expect(r.task.lane).toBe("digitize");
    expect(gh.created.at(-1)?.body).toContain("```relay-job");
  });
});
