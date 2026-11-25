import { defineChannel, POST } from "eve/channels";
import { LEAD_WAKE_PATH } from "@relay/core/lead/client.ts";
import { admitWake, wakeAddress, wakeMessage, WAKE_CALLER } from "../lib/wake.ts";

/** Said once per instance: an unconfigured route is asked by anyone who finds it, and one line is enough. */
let saidNotConfigured = false;

/**
 * Where the relay site wakes the lead about a task that failed, was held, or reached review
 * (`wakeLead` in `@relay/core`). The site proves itself with a signature made from a secret the two deployments
 * share (`RELAY_LEAD_WAKE_SECRET`); it sends no token of any kind, and eve's route auth is not used here, since there
 * is no bearer to walk. One durable session per relay project: the address is the project slug from the verified
 * request, so every wake-up for a project lands in the same conversation and the lead can see what it already did
 * there.
 */
export default defineChannel({
  // Two wake-ups for one project are two decisions. The second waits for the first instead of steering it.
  turnPolicy: "queue",
  routes: [
    POST(LEAD_WAKE_PATH, async (request, { from }) => {
      const wake = await admitWake(request);
      if (!wake.ok) {
        if (wake.code === "wake_not_configured" && !saidNotConfigured) {
          saidNotConfigured = true;
          console.error(`[lead] wake: ${wake.error} Every wake-up is answered 503 until it is set.`);
        }
        return Response.json({ ok: false, code: wake.code, error: wake.error }, { status: wake.status, headers: { "cache-control": "no-store" } });
      }
      // The key makes a redelivered board event the same wake-up: the session ignores a key it has seen.
      const delivery = await from(wakeAddress(wake.body.project)).send(wakeMessage(wake.body), { auth: WAKE_CALLER, idempotencyKey: wake.body.idempotencyKey });
      return Response.json({ ok: true, sessionId: delivery.sessionId, deliveryId: delivery.deliveryId }, { status: 202 });
    }),
  ],
});
