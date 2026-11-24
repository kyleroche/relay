import { isChannel } from "eve/channels";
import { runs } from "eve/events";
import { defineHook } from "eve/hooks";
import wake from "../channels/wake.ts";
import { relayStatus } from "../lib/relay-env.ts";
import { callRelayTool } from "../lib/relay-mcp.ts";
import { turnSpend, usageEvent } from "../lib/usage.ts";
import { projectOfAddress } from "../lib/wake.ts";

/**
 * After each turn, one `external.lead.usage` row in relay's feed with what the turn's model calls spent. The model is
 * not asked to do this: a bill the model writes itself is not a record. A row that cannot be written is logged and
 * dropped, since a turn that already ran must not fail over its receipt.
 */
export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      const relay = relayStatus();
      if (!relay.connected) return;
      const spent = turnSpend(runs(ctx.view, { turnId: event.data.turnId }));
      if (!spent) return;
      // a wake session is a project's; a conversation is not tied to one
      const project = isChannel(ctx.channel, wake) ? projectOfAddress(ctx.channel.continuationToken) : undefined;
      try {
        const signal = AbortSignal.any([ctx.occurrence.abortSignal, AbortSignal.timeout(5_000)]);
        const logged = await callRelayTool(relay, "relay_event_log", usageEvent(spent, project), { signal });
        if (!logged.ok) console.warn(`[lead] usage for turn ${event.data.turnId} was not recorded: ${logged.error}`);
      } catch (e) {
        console.warn(`[lead] usage for turn ${event.data.turnId} was not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
});
