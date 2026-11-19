/** Rows in the `workers` and `claims` tables for the tests of what reads them: the task fold, requeue, close and the lane registry. */
import type { Db } from "../../src/db/client.ts";
import { refreshTaskState } from "../../src/db/task-state.ts";
import { ulid } from "../../src/util.ts";

/** A worker row by name; a second call with the same name replaces its lanes and keeps its id. */
export async function seedWorker(db: Db, w: { name: string; lanes: string[] }): Promise<{ id: string; name: string }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO workers (id, name, lanes) VALUES ($1, $2, $3::text[])
     ON CONFLICT (name) DO UPDATE SET lanes = EXCLUDED.lanes, last_seen = now(), status = 'online' RETURNING id`,
    [ulid(), w.name, w.lanes],
  );
  return { id: r[0]!.id, name: w.name };
}

/** A live lease on a task (30 minutes unless `leaseMs` says otherwise), with the task's state cache rewritten. */
export async function seedClaim(db: Db, taskId: string, workerId: string, opts: { leaseMs?: number; now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  await db.query("INSERT INTO claims (id, task_id, worker_id, lease_until, claimed_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)", [
    ulid(now),
    taskId,
    workerId,
    new Date(now + (opts.leaseMs ?? 30 * 60_000)).toISOString(),
    new Date(now).toISOString(),
  ]);
  await refreshTaskState(db, taskId, now);
}
