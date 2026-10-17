"use server";

import { redirect } from "next/navigation";
import { dataMode } from "@/lib/data";
import { forgetGitHubApp } from "@/lib/github-app";
import { viewerActor } from "@/lib/session";

/** Delete the stored GitHub App (the manifest-flow one). Environment values are untouched; they live in Vercel. */
export async function forgetGitHubAppAction(): Promise<void> {
  if (dataMode() !== "db") redirect("/setup/github?error=This+deployment+runs+on+demo+data.");
  try {
    await viewerActor();
  } catch {
    redirect("/sign-in?next=/setup/github");
  }
  const n = await forgetGitHubApp();
  redirect(`/setup/github?forgot=${n}`);
}
