import type { Subscription } from "@/lib/types";

/** Fixed chart slot per subscription; color follows the entity, never its rank. Shared by server and client code. */
export const SERIES: Array<{ key: Subscription; label: string; color: string }> = [
  { key: "max", label: "Claude Max", color: "var(--series-1)" },
  { key: "codex", label: "Codex", color: "var(--series-2)" },
  { key: "grok", label: "Grok", color: "var(--series-3)" },
];
