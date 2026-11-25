/**
 * The GitHub webhook's lane parsing (lib/webhooks/github.ts) with the lane registry open: an `agent:<lane>` label and
 * a worker's `relay/<lane>-<8 hex>` branch name any lane, a built-in one or one an app registered, by the shape alone.
 */
import { describe, expect, it } from "vitest";
import { githubEvents, laneOf, laneOfLabels, workBranchLane } from "../lib/webhooks/github.ts";

describe("laneOf / laneOfLabels", () => {
  it("reads agent:<lane> for any lane name and nothing else", () => {
    expect(laneOf("agent:claude")).toBe("claude");
    expect(laneOf("agent:nodes")).toBe("nodes");
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

describe("workBranchLane", () => {
  it("reads the lane of a worker's branch, relay/<lane>-<8 hex>, for any lane", () => {
    expect(workBranchLane("relay/claude-53b65c9c")).toBe("claude");
    expect(workBranchLane("relay/embroidery-0a1b2c3d")).toBe("embroidery");
    // eight digits are a hash too, never an issue number
    expect(workBranchLane("relay/laser-cut-12345678")).toBe("laser-cut");
  });

  it("is null for anything else", () => {
    expect(workBranchLane("main")).toBeNull();
    expect(workBranchLane("relay/link")).toBeNull();
    expect(workBranchLane("relay/claude")).toBeNull();
    expect(workBranchLane("relay/claude-42")).toBeNull();
    expect(workBranchLane("relay/Claude-53b65c9c")).toBeNull();
    expect(workBranchLane("relay/claude-53b65c9c-fix")).toBeNull();
    expect(workBranchLane("claude/add-dark-mode")).toBeNull();
    expect(workBranchLane(null)).toBeNull();
    expect(workBranchLane(undefined)).toBeNull();
  });
});

describe("a pull request's row", () => {
  const opened = (pr: Record<string, unknown>) => ({
    action: "opened",
    pull_request: { number: 9, title: "Add dark mode", html_url: "https://github.com/acme/demo/pull/9", ...pr },
    repository: { full_name: "acme/demo", name: "demo" },
    sender: { login: "kyle", type: "User" },
  });

  it("takes the lane from a worker's branch, else from an agent label, and the issue from the body alone", () => {
    expect(githubEvents("pull_request", opened({ head: { ref: "relay/codex-53b65c9c" }, body: "relay task t1, codex lane.\n\nCloses #12" }), "d1")).toMatchObject([{ kind: "pr.opened", actor: "human:kyle", lane: "codex", issue: 12, pr: 9 }]);
    expect(githubEvents("pull_request", opened({ head: { ref: "feature/x" }, labels: [{ name: "agent:grok" }] }), "d2")).toMatchObject([{ lane: "grok", issue: null }]);
  });

  it("reads no lane and no issue from any other branch, whoever pushed it", () => {
    const [row] = githubEvents("pull_request", opened({ head: { ref: "claude/add-dark-mode" }, user: { login: "claude[bot]" } }), "d3");
    expect(row).toMatchObject({ kind: "pr.opened", actor: "human:kyle", lane: null, issue: null });
    expect(row!.payload).not.toHaveProperty("cloud");
    expect(githubEvents("pull_request", opened({ head: { ref: "relay/claude-42" } }), "d4")).toMatchObject([{ lane: null, issue: null }]);
  });

  it("makes no row of a comment", () => {
    expect(githubEvents("issue_comment", { action: "created", issue: { number: 9, pull_request: {} }, comment: { id: 1, body: "<!-- relay:usage -->" }, repository: { full_name: "acme/demo", name: "demo" } }, "d5")).toEqual([]);
  });
});
