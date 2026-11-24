import { createHash } from "node:crypto";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { relayStatus } from "../lib/relay-env.ts";
import { RELAY_TOOLS } from "../lib/relay-tools.ts";

/**
 * relay, reached the way any bot reaches it: the hosted site's MCP server with a bearer token. This is the lead's
 * only way to relay. Dynamic so that an unset RELAY_SITE or RELAY_TOKEN means no connection at all (the instructions
 * then say relay is not connected) instead of a connection to nowhere. It reads the environment and nothing else, so
 * there is no lookup to memoize.
 */
export default defineDynamic(() => {
  const relay = relayStatus();
  if (!relay.connected) return null;
  return defineMcpClientConnection({
    url: `${relay.site}/mcp`,
    // Written for the model as a routing contract: what to come here for, and what is not here.
    description:
      "relay, the owner's task system for their coding agents. Use it to open a task or a plan task (relay_task_create), " +
      "read how tasks stand (relay_task_get, relay_task_list), put a failed task back in the queue or send one in review back with a note " +
      "(relay_task_requeue, relay_task_request_changes), read the owner's standing decisions and preferences and a project's record " +
      "(relay_recall, relay_brief, relay_project, relay_get_project), record a decision the owner states (relay_decide), " +
      "read the feed (relay_feed) and log your own actions (relay_event_log). " +
      "Not here: approving, releasing or closing a task. Those are a person's decisions.",
    // required on an authenticated dynamic connection: which relay this is, and never the token
    instanceKey: relay.site,
    auth: { principalType: "app", getToken: async () => ({ token: relay.token }) },
    // The server publishes more than a planner should hold. Only these reach the model.
    tools: { allow: [...RELAY_TOOLS] },
    toolCall: {
      providedArguments: {
        // eve can run a tool call again when a step is interrupted and replayed, and a second relay_task_create would
        // open a second task. The key is the app's, never the model's: the same call always carries the same one.
        // It is added to every relay call; the tools that take no such argument drop it.
        idempotency_key: ({ session, callId }) => `lead:${createHash("sha256").update(`${session.id}:${callId}`).digest("hex").slice(0, 40)}`,
      },
    },
  });
});
