import { approveTask, parseTaskId, releaseTask, repo, requestChanges, requeueTask, TaskGateError, TaskRequeueError, TaskReviewError } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { needsDb, readJson, siteGitHub, str, writerActor } from "@/lib/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string[] }> };

const ACTIONS = new Set(["approve", "request-changes", "requeue", "release"]);

/** `owner/repo%23n[/approve|/request-changes|/requeue|/release]`: the id and the action the trailing segment names. */
function parts(raw: string[]): { id: string; action: string | null } {
  const segs = raw.map((p) => decodeURIComponent(p));
  if (segs.length === 3 && ACTIONS.has(segs[2] as string)) return { id: `${segs[0]}/${segs[1]}`, action: segs[2] as string };
  return { id: segs.join("/"), action: null };
}

/** operationId: getTask. The id is `owner/repo#n`; the `#` travels as `%23` (`/api/v1/tasks/owner/repo%2342`). */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { id, action } = parts((await ctx.params).id);
    const instance = req.nextUrl.pathname;
    if (action || !parseTaskId(id)) return problem(400, "Bad Request", "task id must be owner/repo#n.", instance, { parameter: "id" });
    if (dataMode() !== "db") return problem(404, "Not Found", `No task ${id}.`, instance);
    const db = await getDb();
    const task = await repo.getTask(db, id);
    if (!task) return problem(404, "Not Found", `No task ${id}.`, instance);
    return json(await repo.taskView(db, task));
  },
  { scope: "tasks:read" },
);

const STATUS_TITLE: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 502: "Bad Gateway", 503: "Service Unavailable" };

/**
 * operationId: approveTask (`…/approve`), requestTaskChanges (`…/request-changes`) and requeueTask (`…/requeue`). The
 * review step of a task in `review` (packages/core/src/tasks/review.ts): approve squash-merges the PR, deletes the
 * branch and writes `task.approved`; request-changes comments on the PR with `{ "note" }` and writes
 * `task.changes_requested` (the task is queued again). Requeue (packages/core/src/tasks/requeue.ts) takes
 * `{ "lane"?, "reason"? }` from any state but `done`: moves the lane label, releases a live claim, writes
 * `task.requeued`. Release (`…/release`, packages/core/src/tasks/gate.ts) takes `{ "note"? }` and lifts the injection
 * gate's hold on a `held` task: writes `task.released`, the task is queued again. A signed-in person is unrestricted; a
 * token needs `tasks:write` (release: `tokens:write`, and never the bot that opened the task) and may not approve a PR
 * its own lane produced. All answer with the updated task.
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const { id, action } = parts((await ctx.params).id);
    const instance = req.nextUrl.pathname;
    if (!action) return problem(405, "Method Not Allowed", "POST …/approve, …/request-changes, …/requeue or …/release; a task itself is read with GET.", instance, {}, { allow: "GET" });
    if (!parseTaskId(id)) return problem(400, "Bad Request", "task id must be owner/repo#n.", instance, { parameter: "id" });
    const refused = needsDb(instance);
    if (refused) return refused;
    const [actor, grant, db, github] = await Promise.all([writerActor(req), callerGrant(req), getDb(), siteGitHub()]);
    const scopes = grant?.scopes ?? [];
    try {
      if (action === "approve") {
        const r = await approveTask(db, github, id, actor, { scopes });
        dispatchAfter(r.events);
        return json(r.task);
      }
      if (action === "requeue") {
        const body = (await readJson(req)) ?? {};
        const r = await requeueTask(db, github, id, actor, { lane: str(body.lane) ?? null, reason: str(body.reason) ?? null, scopes });
        dispatchAfter(r.events);
        return json(r.task);
      }
      if (action === "release") {
        const body = (await readJson(req)) ?? {};
        const r = await releaseTask(db, id, actor, { note: str(body.note) ?? null, scopes });
        dispatchAfter(r.events);
        return json(r.task);
      }
      const body = await readJson(req);
      const note = str(body?.note);
      if (!note) return problem(400, "Bad Request", "Body must be a JSON object with a non-empty note.", instance, { parameter: "note" });
      const r = await requestChanges(db, github, id, actor, note, { scopes });
      dispatchAfter(r.events);
      return json(r.task);
    } catch (e) {
      if (e instanceof TaskRequeueError || e instanceof TaskGateError) return problem(e.status, STATUS_TITLE[e.status] ?? "Error", e.message, instance);
      if (e instanceof TaskReviewError) {
        // the merge refusal is in the feed too (task.merge_failed), so the webhooks hear about it
        const db2 = await getDb();
        const task = await repo.getTask(db2, id);
        if (task && e.status === 502) {
          const events = await repo.taskEvents(db2, task);
          const last = events.at(-1);
          if (last?.kind === "task.merge_failed") dispatchAfter([last]);
        }
        return problem(e.status, STATUS_TITLE[e.status] ?? "Error", e.message, instance);
      }
      throw e;
    }
  },
  { scope: "tasks:write" },
);
