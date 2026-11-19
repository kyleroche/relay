/**
 * The queue version. `queue_state` holds one row; every write that can make a task claimable or take one off the
 * queue bumps `version` (task creation in db/tasks.ts, lease release and expiry in db/workers.ts, the task commands
 * under tasks/).
 */
import { type Db, num } from "./client.ts";

export async function getQueueVersion(db: Db): Promise<number> {
  const r = await db.query<{ version: unknown }>("SELECT version FROM queue_state WHERE one");
  return r[0] ? num(r[0].version) : 0;
}

/** Move the version by one and return it. Call after any write that changes what is queued. */
export async function bumpQueueVersion(db: Db): Promise<number> {
  const r = await db.query<{ version: unknown }>(
    `INSERT INTO queue_state (one, version, updated_at) VALUES (true, 1, now())
     ON CONFLICT (one) DO UPDATE SET version = queue_state.version + 1, updated_at = now() RETURNING version`,
  );
  return num(r[0]?.version);
}
