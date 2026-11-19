import { board } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { siteBoard } from "@/lib/board";
import { needsDb, readJson, siteGitHub, str, writerActor } from "@/lib/integrations";
import { approveFor, closeFor, releaseFor, requestChangesFor, requeueFor } from "@/lib/task-ops";
import { taskProblem } from "@/lib/task-problem";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string[] }> };

const ACTIONS = new Set(["approve", "request-changes", "requeue", "release", "close"]);

/** `<id>` or `<id>/<action>`: a task's ID on the board (URL-encoded, one segment) and the action the trailing segment names. */
function parts(raw: string[]): { id: string; action: string | null } | undefined {
  const segs = raw.map((p) => decodeURIComponent(p));
  if (segs.length === 1) return { id: segs[0]!, action: null };
  if (segs.length === 2 && ACTIONS.has(segs[1]!)) return { id: segs[0]!, action: segs[1]! };
  return undefined;
}

const BAD_PATH = "The path is /api/v1/tasks/{id} or /api/v1/tasks/{id}/{approve|request-changes|requeue|close|release}, where id is the task's ID on the board.";

/** operationId: getTask. One task with its state, the usage rows in its thread and the notes people left there. */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const p = parts((await ctx.params).id);
    const instance = req.nextUrl.pathname;
    if (!p || p.action) return problem(400, "Bad Request", BAD_PATH, instance, { parameter: "id" });
    try {
      const d = await board.getTask((await siteBoard()).board, p.id);
      return json({ ...d.task, usage: d.usage, notes: d.notes });
    } catch (e) {
      return taskProblem(e, instance);
    }
  },
  { scope: "tasks:read" },
);

/**
 * operationId: approveTask (`…/approve`), requestTaskChanges (`…/request-changes`, `{ "note" }`), requeueTask
 * (`…/requeue`, `{ "lane"?, "model"? }`; `"model": null` goes back to the lane's default), closeTask (`…/close`,
 * `{ "reason"? }`) and releaseTask (`…/release`). Each is the board's own task function (packages/core/src/board/
 * tasks.ts), made as the caller's profile, and answers with the updated task. A signed-in person is unrestricted; a
 * token needs `tasks:write`, and to release needs `tokens:write` and must not have opened the task (lib/task-ops.ts).
 */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const p = parts((await ctx.params).id);
    const instance = req.nextUrl.pathname;
    if (!p) return problem(400, "Bad Request", BAD_PATH, instance, { parameter: "id" });
    const { id, action } = p;
    if (!action) return problem(405, "Method Not Allowed", "POST …/approve, …/request-changes, …/requeue, …/close or …/release; a task itself is read with GET.", instance, {}, { allow: "GET" });
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = (await readJson(req)) ?? {};
    try {
      const [actor, grant, session] = await Promise.all([writerActor(req), callerGrant(req), siteBoard()]);
      const asker = { actor, scopes: grant?.scopes ?? [] };
      if (action === "approve") {
        const r = await approveFor(session, await siteGitHub(), asker, id);
        return json({ ...r.task, pr_url: r.pr_url, merge_sha: r.merge_sha, branch_deleted: r.branch_deleted });
      }
      if (action === "requeue") {
        const lane = str(body.lane);
        const model = body.model === null ? null : str(body.model);
        return json(await requeueFor(session, asker, id, { ...(lane ? { lane } : {}), ...(model !== undefined ? { model } : {}) }));
      }
      if (action === "close") {
        const r = await closeFor(session, await siteGitHub(), asker, id, str(body.reason));
        return json({ ...r.task, github: r.github, canceled: r.canceled, to_review: r.to_review });
      }
      if (action === "release") return json(await releaseFor(session, asker, id));
      const note = str(body.note);
      if (!note) return problem(400, "Bad Request", "Body must be a JSON object with a non-empty note.", instance, { parameter: "note" });
      return json(await requestChangesFor(session, await siteGitHub(), asker, id, note));
    } catch (e) {
      return taskProblem(e, instance);
    }
  },
  { scope: "tasks:write" },
);
