/**
 * Shared bits for the integration routes (/api/v1/tasks, /events, /tokens, /webhooks, /projects/{slug} uploads):
 * JSON body parsing, the GitHub client the site uses to open issues, the actor rule for external writers, and the
 * "needs a database" refusal mock deployments answer with.
 */
import { detectGitHub, type GitHubClient } from "@relay/core";
import { externalActor } from "@relay/mcp";
import type { NextResponse } from "next/server";
import { callerGrant, problem } from "@/lib/api";
import { dataMode } from "@/lib/data";

export type JsonBody = Record<string, unknown>;

export async function readJson(req: Request): Promise<JsonBody | undefined> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonBody) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The web app never shells out to gh. It acts as the GitHub App when one is configured (environment, or the sealed
 * settings the manifest flow wrote), else with GITHUB_APP_TOKEN or GITHUB_TOKEN; undefined when neither exists.
 */
export async function siteGitHub(): Promise<GitHubClient | undefined> {
  const { githubApp } = await import("@/lib/github-app");
  const app = await githubApp().catch(() => undefined);
  return detectGitHub(process.env, { allowGh: false, ...(app ? { app: app.client() } : {}) });
}

/** 501 for writes that need the database and an operator (mock deployments serve demo data only). */
export function needsDb(instance: string): NextResponse | null {
  return dataMode() === "db" ? null : problem(501, "Not Implemented", "This operation needs a database (RELAY_DATA=db or DATABASE_URL). Mock mode serves demo data only.", instance);
}

/** `bot:<token name>` for a token, `human:<login>` for a signed-in viewer; the client never picks its own name. */
export async function writerActor(req: Request): Promise<string> {
  const grant = await callerGrant(req);
  return externalActor(grant?.actor ?? "token:unknown");
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const int = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? n : undefined;
};
