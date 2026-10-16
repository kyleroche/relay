import { parseTaskId, repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string[] }> };

/** operationId: getTask. The id is `owner/repo#n`; the `#` travels as `%23` (`/api/v1/tasks/owner/repo%2342`). */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { id: parts } = await ctx.params;
    const id = parts.map((p) => decodeURIComponent(p)).join("/");
    const instance = req.nextUrl.pathname;
    if (!parseTaskId(id)) return problem(400, "Bad Request", "task id must be owner/repo#n.", instance, { parameter: "id" });
    if (dataMode() !== "db") return problem(404, "Not Found", `No task ${id}.`, instance);
    const db = await getDb();
    const task = await repo.getTask(db, id);
    if (!task) return problem(404, "Not Found", `No task ${id}.`, instance);
    return json(await repo.taskView(db, task));
  },
  { scope: "tasks:read" },
);
