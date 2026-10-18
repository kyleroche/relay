"use server";

import { forgetWorkerServer, WorkError } from "@relay/core";
import { revalidatePath } from "next/cache";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { dispatchAfter } from "@/lib/dispatch";
import { CROSS_SITE_MESSAGE } from "@/lib/fetch-site";
import { requestIsCrossSite, viewerActor } from "@/lib/session";

export interface WorkerActionResult {
  ok: boolean;
  message?: string;
  name?: string;
}

/**
 * The Forget button on /workers: the same core call as `relay work forget` and DELETE /api/v1/workers/{id}, as the
 * signed-in person. Refused without a database, on a cross-site request (lib/fetch-site.ts) or once the session is gone.
 */
export async function forgetWorkerAction(idOrName: string): Promise<WorkerActionResult> {
  if (dataMode() !== "db") return { ok: false, message: "This needs a database; the deployment runs on demo data." };
  if (await requestIsCrossSite()) return { ok: false, message: CROSS_SITE_MESSAGE };
  let by: string;
  try {
    by = await viewerActor();
  } catch {
    return { ok: false, message: "Your session has ended. Sign in again." };
  }
  try {
    const r = await forgetWorkerServer(await getDb(), idOrName, by);
    dispatchAfter(r.events);
    revalidatePath("/workers");
    return { ok: true, name: r.worker.name };
  } catch (e) {
    if (e instanceof WorkError) return { ok: false, message: e.message };
    throw e;
  }
}
