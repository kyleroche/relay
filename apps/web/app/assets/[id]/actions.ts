"use server";

import { PublishUnsupportedError } from "@relay/core";
import { revalidatePath } from "next/cache";
import { afterReview } from "@/lib/asset-hooks";
import { publishAsset, reviewAsset } from "@/lib/data";
import { viewerActor } from "@/lib/session";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/**
 * The viewer's approve / reject, attributed to the signed-in user (`human:<login>`). In mock mode the fake viewer is
 * `human:demo`, or RELAY_REVIEWER when that is set. Without a session the action refuses rather than writing as nobody.
 */
export async function reviewAction(id: string, decision: "approved" | "rejected", note: string): Promise<ActionResult> {
  const trimmed = note.trim();
  if (decision === "rejected" && !trimmed) return { ok: false, message: "A rejection needs a note; it becomes the decision the next attempt reads." };
  let by: string;
  try {
    by = await viewerActor();
  } catch {
    return { ok: false, message: "Your session has ended. Sign in again to review." };
  }
  const asset = await reviewAsset(id, { decision, by, note: trimmed || null });
  if (!asset) return { ok: false, message: "This asset no longer exists." };
  await afterReview(asset);
  revalidatePath("/assets");
  revalidatePath(`/assets/${id}`);
  revalidatePath("/");
  return { ok: true };
}

export async function publishAction(id: string): Promise<ActionResult> {
  let by: string;
  try {
    by = await viewerActor();
  } catch {
    return { ok: false, message: "Your session has ended. Sign in again to publish." };
  }
  try {
    const asset = await publishAsset(id, by);
    if (!asset) return { ok: false, message: "This asset no longer exists." };
  } catch (e) {
    if (e instanceof PublishUnsupportedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Publish failed." };
  }
  revalidatePath("/assets");
  revalidatePath(`/assets/${id}`);
  return { ok: true };
}
