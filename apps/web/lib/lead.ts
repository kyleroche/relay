/**
 * Waking relay's lead (apps/lead, an optional deployment of its own) when a task needs someone's attention: it
 * failed, the gate held it, or it reached review. The site only knocks: `wakeLead` posts what happened to the lead's
 * `/relay/wake` with this deployment's own Vercel OIDC token, which the lead checks against the team and project it
 * was told to expect. What the lead then does goes through relay's MCP server like any other bot's work.
 *
 * Off unless `RELAY_LEAD_URL` names the lead. A wake-up that fails is logged and dropped: the task is on the board
 * either way, and the lead reads the board when it is next woken.
 */
import { board, wakeLead } from "@relay/core";
import type { BoardEventView } from "@vercel/board";
import { getVercelOidcToken } from "@vercel/oidc";

export const leadUrl = (env: Record<string, string | undefined> = process.env): string | undefined => env.RELAY_LEAD_URL?.trim() || undefined;

export interface LeadDeps {
  url?: string;
  token?: () => Promise<string>;
  fetch?: typeof fetch;
}

/** Wake the lead for one board event, if it is one the lead is woken for. Says what it did; never throws. */
export async function wakeLeadFor(event: BoardEventView, trusted: readonly string[], deps: LeadDeps = {}): Promise<{ woke: boolean; why?: string }> {
  const url = deps.url ?? leadUrl();
  if (!url) return { woke: false };
  const wake = board.leadWakeOf(event, trusted);
  if (!wake) return { woke: false };
  try {
    const r = await wakeLead({ url, token: await (deps.token ?? getVercelOidcToken)(), ...wake, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    if (r.ok) return { woke: true };
    console.error(`[relay] lead: ${wake.event.kind} of ${wake.task.id} not delivered (${r.status || "no response"}): ${r.error}`);
    return { woke: false, why: r.error };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`[relay] lead: ${wake.event.kind} of ${wake.task.id} not delivered: ${why}`);
    return { woke: false, why };
  }
}
