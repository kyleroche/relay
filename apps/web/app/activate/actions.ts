"use server";

import { decideDeviceRequest, OAuthError } from "@relay/core";
import { redirect } from "next/navigation";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { CROSS_SITE_MESSAGE } from "@/lib/fetch-site";
import { oauthOptions } from "@/lib/oauth";
import { requestIsCrossSite, viewerActor } from "@/lib/session";

/** The /activate form: look a code up (redirect with ?code=) or decide one (redirect with ?code=&done=). */
export async function activateAction(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const raw = String(formData.get("decision") ?? "");
  const back = (extra: Record<string, string>) => redirect(`/activate?${new URLSearchParams({ code, ...extra }).toString()}`);
  if (!code) redirect("/activate");
  if (raw !== "approve" && raw !== "deny") back({});
  const decision: "approve" | "deny" = raw === "approve" ? "approve" : "deny";
  if (dataMode() !== "db") back({ error: "This deployment runs on demo data; approvals need a database." });
  if (await requestIsCrossSite()) back({ error: CROSS_SITE_MESSAGE });
  let actor: string;
  try {
    actor = await viewerActor();
  } catch {
    redirect(`/sign-in?next=${encodeURIComponent(`/activate?code=${code}`)}`);
  }
  try {
    const row = await decideDeviceRequest(await getDb(), code, decision, actor, oauthOptions());
    back({ done: row.status, client: row.client_name });
  } catch (e) {
    if (e instanceof OAuthError) back({ error: e.description });
    throw e;
  }
}
