import type { FeedEvent } from "@/lib/types";

/** Public shape of an event: no raw payload, no dedupe key. */
export type PublicEvent = Omit<FeedEvent, "payload" | "dedupe_key">;

export function sanitizeEvent(e: FeedEvent): PublicEvent {
  const { payload: _payload, dedupe_key: _dedupe, ...rest } = e;
  return rest;
}
