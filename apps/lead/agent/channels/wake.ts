import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse, routeAuth } from "eve/channels/auth";
import { LEAD_WAKE_PATH, parseLeadWake } from "@relay/core/lead/client.ts";
import { relayStatus } from "../lib/relay-env.ts";
import { wakeAddress, wakeAuth, wakeCallerProblem, wakeCallers, wakeMessage } from "../lib/wake.ts";

/** A wake-up is a few short fields. Anything larger is not one. */
const MAX_BODY_BYTES = 16 * 1024;

const refuse = (status: number, code: string, error: string): Response => Response.json({ ok: false, code, error }, { status, headers: { "cache-control": "no-store" } });

/**
 * Where the relay site wakes the lead about a task that failed, was held, or reached review
 * (`wakeLead` in `@relay/core`). One durable session per relay project: the address is the project slug from the
 * verified request, so every wake-up for a project lands in the same conversation and the lead can see what it
 * already did there.
 */
export default defineChannel({
  // Two wake-ups for one project are two decisions. The second waits for the first instead of steering it.
  turnPolicy: "queue",
  routes: [
    POST(LEAD_WAKE_PATH, async (request, { from }) => {
      const callers = wakeCallers();
      if (callers.problem) console.error(`[lead] wake: ${callers.problem}`);
      const caller = await routeAuth(request, wakeAuth(callers));
      if (caller instanceof Response) return caller;
      const problem = wakeCallerProblem(caller, callers);
      if (problem) return createUnauthorizedResponse({ status: 403, message: problem });
      // Without relay the lead could only answer a wake-up with silence, and each turn is a paid model call. The
      // site hears why instead. Said only to a caller that passed auth.
      const relay = relayStatus();
      if (!relay.connected) return refuse(503, "relay_not_connected", `The lead has no relay connection: ${relay.invalid ?? `${relay.missing.join(" and ")} not set on it`}.`);

      const raw = await request.text();
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return refuse(413, "wake_too_large", "A wake-up is at most 16 KiB.");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return refuse(400, "invalid_wake", "The body is not JSON.");
      }
      const wake = parseLeadWake(json);
      if (!wake.ok) return refuse(400, "invalid_wake", wake.error);

      // The key makes a redelivered board event the same wake-up: the session ignores a key it has seen.
      const delivery = await from(wakeAddress(wake.body.project)).send(wakeMessage(wake.body), { auth: caller, idempotencyKey: wake.body.idempotencyKey });
      return Response.json({ ok: true, sessionId: delivery.sessionId, deliveryId: delivery.deliveryId }, { status: 202 });
    }),
  ],
});
