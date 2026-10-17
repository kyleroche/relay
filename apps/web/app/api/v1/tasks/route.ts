import { isTaskState, openTask, repo, TaskCreateError, TASK_LANES, TASK_PRIORITIES, TASK_STATES, type TaskLane, type TaskPriority } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { dispatchCloudAfter } from "@/lib/cloud-dispatch";
import { dispatchAfter } from "@/lib/dispatch";
import { int, needsDb, readJson, siteGitHub, str, writerActor } from "@/lib/integrations";

export const dynamic = "force-dynamic";

/** operationId: listTasks. Tasks with derived state, newest first. Query: project, state, limit. */
export const GET = api(
  async (req) => {
    const sp = req.nextUrl.searchParams;
    const instance = req.nextUrl.pathname;
    if (dataMode() !== "db") return json({ tasks: [], count: 0 });
    const state = sp.get("state");
    if (state && !isTaskState(state)) return problem(400, "Bad Request", `state must be one of ${TASK_STATES.join(", ")}.`, instance, { parameter: "state" });
    const limit = int(sp.get("limit")) ?? 50;
    if (limit < 1 || limit > 200) return problem(400, "Bad Request", "limit must be an integer between 1 and 200.", instance, { parameter: "limit" });
    const tasks = await repo.listTaskViews(await getDb(), { ...(sp.get("project") ? { project: sp.get("project") as string } : {}), ...(state && isTaskState(state) ? { state } : {}), limit });
    return json({ tasks, count: tasks.length });
  },
  { scope: "tasks:read" },
);

/**
 * operationId: createTask. Body: { project, title, body?, lane, priority?, idempotency_key? }. Opens the GitHub issue
 * with the agent:<lane> label, records the task, writes issue.opened and task.created. 201 on create, 200 when the
 * idempotency key matched an earlier task.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const lane = str(body.lane);
    const priority = str(body.priority);
    if (!lane || !(TASK_LANES as readonly string[]).includes(lane)) return problem(400, "Bad Request", `lane must be one of ${TASK_LANES.join(", ")}.`, instance, { parameter: "lane" });
    if (priority && !(TASK_PRIORITIES as readonly string[]).includes(priority)) return problem(400, "Bad Request", `priority must be one of ${TASK_PRIORITIES.join(", ")}.`, instance, { parameter: "priority" });
    const project = str(body.project);
    const title = str(body.title);
    if (!project) return problem(400, "Bad Request", "project is required.", instance, { parameter: "project" });
    if (!title) return problem(400, "Bad Request", "title is required.", instance, { parameter: "title" });
    const actor = await writerActor(req);
    try {
      const r = await openTask(await getDb(), await siteGitHub(), {
        project,
        title,
        body: typeof body.body === "string" ? body.body : "",
        lane: lane as TaskLane,
        ...(priority ? { priority: priority as TaskPriority } : {}),
        idempotency_key: str(body.idempotency_key) ?? null,
        actor,
      });
      dispatchAfter(r.events);
      // cloud lanes are dispatched by the site itself (lib/cloud-dispatch.ts); worker lanes wait for `relay work` to claim them
      if (r.created) dispatchCloudAfter(r.task, lane, actor);
      return json({ task_id: r.task_id, issue_url: r.issue_url, created: r.created, task: r.task }, { status: r.created ? 201 : 200, headers: { location: `/api/v1/tasks/${r.task_id.replace("#", "%23")}` } });
    } catch (e) {
      if (e instanceof TaskCreateError) return problem(e.status, e.status === 404 ? "Not Found" : e.status === 503 ? "Service Unavailable" : "Bad Request", e.message, instance);
      throw e;
    }
  },
  { scope: "tasks:write" },
);
