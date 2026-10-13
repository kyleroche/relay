"use server";

import { PublishUnsupportedError } from "@relay/core";
import { revalidatePath } from "next/cache";
import { afterReview } from "@/lib/asset-hooks";
import { publishAsset, reviewAsset } from "@/lib/data";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/**
 * The viewer's approve / reject. TODO(auth): the reviewer is the signed-in user once sign-in lands; until then
 * RELAY_REVIEWER names who the web app's reviews are attributed to (default human:web).
 */
export async function reviewAction(id: string, decision: "approved" | "rejected", note: string): Promise<ActionResult> {
  const trimmed = note.trim();
  if (decision === "rejected" && !trimmed) return { ok: false, message: "A rejection needs a note; it becomes the decision the next attempt reads." };
  const asset = await reviewAsset(id, { decision, by: process.env.RELAY_REVIEWER ?? "human:web", note: trimmed || null });
  if (!asset) return { ok: false, message: "This asset no longer exists." };
  await afterReview(asset);
  revalidatePath("/assets");
  revalidatePath(`/assets/${id}`);
  revalidatePath("/");
  return { ok: true };
}

export async function publishAction(id: string): Promise<ActionResult> {
  try {
    const asset = await publishAsset(id, process.env.RELAY_REVIEWER ?? "human:web");
    if (!asset) return { ok: false, message: "This asset no longer exists." };
  } catch (e) {
    if (e instanceof PublishUnsupportedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Publish failed." };
  }
  revalidatePath("/assets");
  revalidatePath(`/assets/${id}`);
  return { ok: true };
}
