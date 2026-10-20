import { isWorkerLane, registerWorkerServer, repo, WORKER_LANES, WORKER_NAME } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { needsDb, readJson, str } from "@/lib/integrations";
import { strList, workProblem } from "@/lib/work";

export const dynamic = "force-dynamic";

/** operationId: listWorkers. Every worker with its derived state (online, idle, offline) and current task. */
export const GET = api(
  async () => {
    if (dataMode() !== "db") return json({ workers: [], count: 0 });
    const workers = await repo.workerViews(await getDb());
    return json({ workers, count: workers.length });
  },
  { scope: "feed:read" },
);

/**
 * operationId: registerWorker. Body: { name, host?, lanes, labels?, version? }. Upserts the worker by name (the id is
 * stable across restarts) and writes worker.registered on first sight and worker.online when it comes back.
 */
export const POST = api(
  async (req) => {
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body) return problem(400, "Bad Request", "Body must be a JSON object.", instance);
    const name = str(body.name);
    if (!name || !WORKER_NAME.test(name)) return problem(400, "Bad Request", "name is required: 1-64 characters, letters, digits, dot, dash, underscore.", instance, { parameter: "name" });
    const lanes = strList(body.lanes) ?? [];
    if (lanes.some((l) => !isWorkerLane(l))) return problem(400, "Bad Request", `lanes must be among ${WORKER_LANES.join(", ")}.`, instance, { parameter: "lanes" });
    try {
      const r = await registerWorkerServer(await getDb(), { name, host: str(body.host) ?? "", lanes, labels: strList(body.labels) ?? [], version: str(body.version) ?? "" });
      dispatchAfter(r.events);
      return json({ worker: r.worker, created: r.created, events: r.events.map((e) => ({ id: e.id, kind: e.kind })) }, { status: r.created ? 201 : 200 });
    } catch (e) {
      return workProblem(e, instance) ?? Promise.reject(e);
    }
  },
  { scope: "work:claim" },
);
