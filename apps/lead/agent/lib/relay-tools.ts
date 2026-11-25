/**
 * The relay tools the lead may call, and the ones it must never be given. The connection offers the model only the
 * first list; the second exists so a test fails the day someone adds one of them to it.
 *
 * This list is the lead's own lock, and the lead is the only thing that enforces it. The lock that holds when the
 * lead is wrong (a prompt that got through, a bug here) is on relay's server: every tool there needs a scope
 * (`TOOL_SCOPES` in `packages/mcp/src/server.ts`), and the lead's token carries only `LEAD_SCOPES`
 * (`relay-env.ts`), which stops at `tasks:write`. `test/lib.test.ts` checks the two against each other.
 */

export const RELAY_TOOLS = [
  "relay_task_create",
  "relay_task_get",
  "relay_task_list",
  "relay_task_requeue",
  "relay_task_request_changes",
  "relay_recall",
  "relay_brief",
  "relay_project",
  "relay_get_project",
  "relay_feed",
  "relay_event_log",
] as const;

/**
 * Decisions that are a person's (approve, release, close), standing memory (a decision or a preference lands in every
 * later brief, and a wake-up's text was written by a worker, so the lead reads memory and never writes it), and
 * powers a planner has no use for (assets, tokens, invites, access). The server refuses the lead's token every one
 * of these: approve and close need `tasks:decide`, release and the access tools `tokens:write`, memory writes
 * `memory:write`, assets the `assets:*` scopes, and the token has none of them.
 */
export const RELAY_TOOLS_NEVER = [
  "relay_task_approve",
  "relay_task_release",
  "relay_task_close",
  "relay_decide",
  "relay_prefer",
  "relay_asset_list",
  "relay_asset_get",
  "relay_asset_request_upload",
  "relay_asset_finalize",
  "relay_asset_review",
  "relay_access_list",
  "relay_access_approve",
  "relay_invite_create",
  "relay_invite_revoke",
] as const;

/** The connection's name, from its file (`agent/connections/relay.ts`). eve names its tools `relay__<tool>`. */
export const RELAY_CONNECTION = "relay";
export const qualified = (tool: string): string => `${RELAY_CONNECTION}__${tool}`;
