/**
 * The relay tools the lead may call, and the ones it must never be given. The connection offers the model only the
 * first list; the second exists so a test fails the day someone adds one of them to it.
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
  "relay_decide",
  "relay_feed",
  "relay_event_log",
] as const;

/**
 * Decisions that are a person's (approve, release, close) and powers a planner has no use for (assets, tokens,
 * invites, access). The lead's token should not carry the scopes for most of these either; this is the second lock.
 */
export const RELAY_TOOLS_NEVER = [
  "relay_task_approve",
  "relay_task_release",
  "relay_task_close",
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
