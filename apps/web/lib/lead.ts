/**
 * Waking relay's lead (apps/lead, an optional deployment of its own) when a task needs someone's attention: it
 * failed, the gate held it, or it reached review. The site only knocks: `wakeLead` posts what happened to the lead's
 * `/relay/wake`, signed with a secret the two deployments share (`RELAY_LEAD_WAKE_SECRET`). The signature says "this
 * is the site" to the lead and is worth nothing anywhere else. This deployment's own Vercel identity is never sent:
 * it is the site's credential on the team's board, where the site's word decides grants and releases. What the lead
 * then does goes through relay's MCP server like any other bot's work.
 *
 * Off unless `RELAY_LEAD_URL` names the lead, and nothing is sent without a usable secret. A wake-up that fails is
 * logged and dropped: the task is on the board either way, and the lead reads the board when it is next woken.
 */
import { board, LEAD_WAKE_SECRET_ENV, leadWakeSecret, wakeLead } from "@relay/core";
import type { BoardEventView } from "@vercel/board";

type Env = Record<string, string | undefined>;

export const leadUrl = (env: Env = process.env): string | undefined => env.RELAY_LEAD_URL?.trim() || undefined;

/** The secret this deployment signs wake-ups with, or why it has none it can use. */
export const leadSecret = (env: Env = process.env) => leadWakeSecret(env[LEAD_WAKE_SECRET_ENV]);

export interface LeadDeps {
  url?: string;
  /** The shared secret; read from the environment when not given. */
  secret?: string;
  fetch?: typeof fetch;
  /** Where the one line about a missing secret goes; `console.error` by default. */
  log?: (line: string) => void;
}

/** A lead with no secret would be told so for every board event. Once per instance is enough. */
let saidNoSecret = false;

/** Wake the lead for one board event, if it is one the lead is woken for. Says what it did; never throws. */
export async function wakeLeadFor(event: BoardEventView, trusted: readonly string[], deps: LeadDeps = {}): Promise<{ woke: boolean; why?: string }> {
  const url = deps.url ?? leadUrl();
  if (!url) return { woke: false };
  const wake = board.leadWakeOf(event, trusted);
  if (!wake) return { woke: false };
  const secret = deps.secret === undefined ? leadSecret() : leadWakeSecret(deps.secret);
  if (!secret.ok) {
    if (!saidNoSecret) {
      saidNoSecret = true;
      (deps.log ?? console.error)(`[relay] lead: RELAY_LEAD_URL is set but ${secret.error}, so no wake-up is sent. Set the same ${LEAD_WAKE_SECRET_ENV} on this project and on the lead's.`);
    }
    return { woke: false, why: secret.error };
  }
  try {
    const r = await wakeLead({ url, secret: secret.secret, ...wake, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    if (r.ok) return { woke: true };
    console.error(`[relay] lead: ${wake.event.kind} of ${wake.task.id} not delivered (${r.status || "no response"}): ${r.error}`);
    return { woke: false, why: r.error };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`[relay] lead: ${wake.event.kind} of ${wake.task.id} not delivered: ${why}`);
    return { woke: false, why };
  }
}
