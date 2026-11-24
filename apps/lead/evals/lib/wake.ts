/** Wake the lead under test the way the site does, and read the turn that follows. */
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";
import { LEAD_WAKE_PATH, LEAD_WAKE_SECRET_ENV, LEAD_WAKE_SIGNATURE_HEADER, LEAD_WAKE_TIMESTAMP_HEADER, leadWakeKey, signLeadWake, type LeadWakeBody } from "@relay/core/lead/client.ts";

export interface Woken {
  session: EveEvalSession;
  turn: EveEvalTurn;
}

/**
 * POST the wake route with the body `wakeLead` builds, signed as `wakeLead` signs it. The route has one door, the
 * signature, on a local development server too; the secret is the one `evals.config.ts` made up for this run.
 * `session` is the one an earlier wake-up of the same project returned: a project has one session, so its next turn
 * is read from where the last read stopped.
 */
export async function wake(t: EveEvalContext<unknown>, body: Omit<LeadWakeBody, "idempotencyKey">, session?: EveEvalSession): Promise<Woken> {
  const secret = process.env[LEAD_WAKE_SECRET_ENV];
  if (!secret) throw new Error(`${LEAD_WAKE_SECRET_ENV} is not set: evals.config.ts sets it before the agent starts`);
  const raw = JSON.stringify({ ...body, idempotencyKey: leadWakeKey(body.event.cursor) } satisfies LeadWakeBody);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await t.target.fetch(LEAD_WAKE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", [LEAD_WAKE_TIMESTAMP_HEADER]: timestamp, [LEAD_WAKE_SIGNATURE_HEADER]: signLeadWake(secret, timestamp, raw) },
    body: raw,
  });
  const answer = (await res.json()) as { ok?: boolean; sessionId?: string; error?: string };
  if (res.status !== 202 || !answer.sessionId) throw new Error(`the wake route answered ${res.status}: ${answer.error ?? "no session"}`);
  if (session && session.id !== answer.sessionId) throw new Error(`a second wake-up for ${body.project} landed in another session`);
  const attached = session ?? t.target.attach(answer.sessionId);
  return { session: attached, turn: await attached.nextTurn() };
}

/** Whether a turn ended without a message. A wake-up has no reader, so any text is a failure. */
export const silent = (reply: string | undefined): boolean => (reply ?? "").trim() === "";
