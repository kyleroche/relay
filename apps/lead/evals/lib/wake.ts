/** Wake the lead under test the way the site does, and read the turn that follows. */
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";
import { LEAD_WAKE_PATH, leadWakeKey, type LeadWakeBody } from "@relay/core/lead/client.ts";

export interface Woken {
  session: EveEvalSession;
  turn: EveEvalTurn;
}

/**
 * POST the wake route with the body `wakeLead` builds. The eval's target is a local development server, which is the
 * one place the route answers without a Vercel OIDC token. `session` is the one an earlier wake-up of the same
 * project returned: a project has one session, so its next turn is read from where the last read stopped.
 */
export async function wake(t: EveEvalContext<unknown>, body: Omit<LeadWakeBody, "idempotencyKey">, session?: EveEvalSession): Promise<Woken> {
  const res = await t.target.fetch(LEAD_WAKE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, idempotencyKey: leadWakeKey(body.event.cursor) } satisfies LeadWakeBody),
  });
  const answer = (await res.json()) as { ok?: boolean; sessionId?: string; error?: string };
  if (res.status !== 202 || !answer.sessionId) throw new Error(`the wake route answered ${res.status}: ${answer.error ?? "no session"}`);
  if (session && session.id !== answer.sessionId) throw new Error(`a second wake-up for ${body.project} landed in another session`);
  const attached = session ?? t.target.attach(answer.sessionId);
  return { session: attached, turn: await attached.nextTurn() };
}

/** Whether a turn ended without a message. A wake-up has no reader, so any text is a failure. */
export const silent = (reply: string | undefined): boolean => (reply ?? "").trim() === "";
