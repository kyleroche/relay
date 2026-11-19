import { board } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { siteBoard } from "@/lib/board";
import { getDb } from "@/lib/db";
import { int, needsDb, readJson, writerActor } from "@/lib/integrations";
import { openTaskFor } from "@/lib/task-ops";
import { taskProblem } from "@/lib/task-problem";

export const dynamic = "force-dynamic";

const STATES: readonly string[] = [...board.RELAY_STATES, "open", "all"];

/**
 * operationId: listTasks. Tasks on the team's board, oldest first (the order a queue is worked in). Query: project,
 * state (one of relay's states, `open` for everything not done or closed, which is the default, or `all`), lane, limit.
 */
export const GET = api(
  async (req) => {
    const sp = req.nextUrl.searchParams;
    const instance = req.nextUrl.pathname;
    const state = sp.get("state") ?? "open";
    if (!STATES.includes(state)) return problem(400, "Bad Request", `state must be one of ${STATES.join(", ")}.`, instance, { parameter: "state" });
    const limit = int(sp.get("limit")) ?? 50;
    if (limit < 1 || limit > 200) return problem(400, "Bad Request", "limit must be an integer between 1 and 200.", instance, { parameter: "limit" });
    const project = sp.get("project");
    const lane = sp.get("lane");
    if (project && !board.PROJECT_SLUG.test(project)) return problem(400, "Bad Request", "project must be a project slug.", instance, { parameter: "project" });
    try {
      const tasks = await board.listTasks((await siteBoard()).board, { ...(project ? { project } : {}), state: state as board.ListTasksOptions["state"], ...(lane ? { lane } : {}), limit });
      return json({ tasks, count: tasks.length });
    } catch (e) {
      return taskProblem(e, instance);
    }
  },
  { scope: "tasks:read" },
);

/**
 * operationId: createTask. Body: { project, title, body?, lane, model?, needs?, base?, idempotency_key? }. Opens a
 * thread in the project's queue on the board as the caller's profile; the repository is the project's registration.
 * 201 on create, 200 when the caller's idempotency key already made the task. A lane no worker serves is refused with
 * the lanes that have one.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    try {
      const [actor, grant] = await Promise.all([writerActor(req), callerGrant(req)]);
      const r = await openTaskFor(await getDb(), await siteBoard(), { actor, scopes: grant?.scopes ?? [] }, body);
      return json({ task_id: r.task.id, created: r.created, task: r.task }, { status: r.created ? 201 : 200, headers: { location: `/api/v1/tasks/${encodeURIComponent(r.task.id)}` } });
    } catch (e) {
      return taskProblem(e, instance);
    }
  },
  { scope: "tasks:write" },
);
