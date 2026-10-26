/**
 * The GitHub webhook's lane parsing (lib/webhooks/github.ts) with the lane registry open: an `agent:<lane>` label and
 * a `relay/<lane>-<issue>` branch name any lane, a built-in one or one an app registered, by the shape alone.
 */
import { describe, expect, it } from "vitest";
import { laneOf, laneOfLabels, relayBranch } from "../lib/webhooks/github.ts";

describe("laneOf / laneOfLabels", () => {
  it("reads agent:<lane> for any lane name and nothing else", () => {
    expect(laneOf("agent:claude")).toBe("claude");
    expect(laneOf("agent:nodes")).toBe("nodes");
    expect(laneOf("agent:claude-cloud")).toBe("claude-cloud");
    expect(laneOf("agent:embroidery")).toBe("embroidery");
    expect(laneOf("agent:laser-cut")).toBe("laser-cut");
    expect(laneOf("agent:Embroidery")).toBeNull();
    expect(laneOf("agent:")).toBeNull();
    expect(laneOf("agent:a_b")).toBeNull();
    expect(laneOf(`agent:${"a".repeat(33)}`)).toBeNull();
    expect(laneOf("priority:high")).toBeNull();
    expect(laneOf("production:nightfall")).toBeNull();
    expect(laneOf(undefined)).toBeNull();
  });

  it("takes the first agent:* label from GitHub label objects or plain strings", () => {
    expect(laneOfLabels([{ name: "priority:high" }, { name: "agent:embroidery" }, { name: "agent:claude" }])).toBe("embroidery");
    expect(laneOfLabels(["production:x", "agent:grok"])).toBe("grok");
    expect(laneOfLabels([{ name: "priority:high" }])).toBeNull();
    expect(laneOfLabels("agent:claude")).toBeNull();
    expect(laneOfLabels(undefined)).toBeNull();
  });
});

describe("relayBranch", () => {
  it("reads relay/<lane>-<issue> for any lane, the shortest lane that leaves an issue number", () => {
    expect(relayBranch("relay/claude-42")).toEqual({ lane: "claude", issue: 42 });
    expect(relayBranch("relay/embroidery-7")).toEqual({ lane: "embroidery", issue: 7 });
    expect(relayBranch("relay/laser-cut-42")).toEqual({ lane: "laser-cut", issue: 42 });
    expect(relayBranch("relay/claude-7-fix")).toEqual({ lane: "claude", issue: 7 });
    expect(relayBranch("relay/codex-12/retry")).toEqual({ lane: "codex", issue: 12 });
    // the older spelling
    expect(relayBranch("relay/42-claude")).toEqual({ lane: "claude", issue: 42 });
    expect(relayBranch("relay/42-embroidery")).toEqual({ lane: "embroidery", issue: 42 });
  });

  it("is null for anything else", () => {
    expect(relayBranch("main")).toBeNull();
    expect(relayBranch("relay/Claude-1")).toBeNull();
    expect(relayBranch("relay/claude")).toBeNull();
    expect(relayBranch("claude/add-dark-mode")).toBeNull();
    expect(relayBranch(null)).toBeNull();
    expect(relayBranch(undefined)).toBeNull();
  });
});
