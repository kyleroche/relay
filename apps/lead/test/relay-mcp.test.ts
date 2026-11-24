/**
 * The usage hook's one call to relay, against the evals' fake: the same MCP server library and stateless transport as
 * a relay site's `/mcp`. Also what keeps the fake honest, since the evals that depend on it are not run here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callRelayTool, parseRpcReply } from "../agent/lib/relay-mcp.ts";
import { usageEvent } from "../agent/lib/usage.ts";
import { startFakeRelay, type FakeRelay } from "../evals/lib/fake-relay.ts";

let fake: FakeRelay;
beforeAll(async () => {
  fake = await startFakeRelay();
});
afterAll(() => fake.close());

describe("callRelayTool", () => {
  it("logs a usage row with one POST and no session to open first", async () => {
    const relay = { site: fake.url, token: fake.token };
    const args = usageEvent({ models: ["openai/a"], runs: 1, inputTokens: 900, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.004 }, "site");
    const logged = await callRelayTool(relay, "relay_event_log", args);
    expect(logged.ok).toBe(true);
    expect(fake.calls("site")).toEqual([{ tool: "relay_event_log", args }]);

    const feed = await callRelayTool(relay, "relay_feed", { project: "site", kind: "external.lead." });
    expect(feed).toMatchObject({ ok: true, text: expect.stringContaining("external.lead.usage bot:lead site: Lead turn on openai/a") });
  });

  it("returns a tool's refusal, a refused token and an unreachable site as errors", async () => {
    const relay = { site: fake.url, token: fake.token };
    expect(await callRelayTool(relay, "relay_task_get", { task_id: "msg_missing" })).toEqual({ ok: false, error: "relay: No task msg_missing" });
    expect(await callRelayTool(relay, "relay_event_log", { kind: "task.approved", summary: "x" })).toMatchObject({ ok: false });
    expect(await callRelayTool({ site: fake.url, token: "not-the-token" }, "relay_feed", {})).toEqual({ ok: false, error: "unknown token" });
    expect(await callRelayTool({ site: "http://127.0.0.1:1", token: "t" }, "relay_feed", {})).toMatchObject({ ok: false, error: expect.stringContaining("could not be reached") });
  });

  it("reads an answer sent as a server-sent event", () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}\n\n';
    expect(parseRpcReply(sse, "text/event-stream")).toMatchObject({ result: { content: [{ type: "text", text: "ok" }] } });
    expect(parseRpcReply("<html>", "text/html")).toBeUndefined();
    expect(parseRpcReply("", null)).toBeUndefined();
  });
});

describe("the fake relay", () => {
  it("keeps tasks the way the wake evals need: a requeue moves the lane, a create is idempotent on its key", async () => {
    const relay = { site: fake.url, token: fake.token };
    fake.seedTask({ task_id: "msg_a", project: "p", title: "A", state: "failed", lane: "codex", reason: "codex did not finish" });
    expect(await callRelayTool(relay, "relay_task_requeue", { id: "msg_a", lane: "claude", idempotency_key: "lead:ignored" })).toMatchObject({ ok: true });
    expect(fake.task("msg_a")).toMatchObject({ state: "queued", lane: "claude", reason: null });

    const create = { project: "p", title: "B", body: "## Do\nx", plan: true, idempotency_key: "lead:k1" };
    const first = await callRelayTool(relay, "relay_task_create", create);
    const second = await callRelayTool(relay, "relay_task_create", create);
    if (!first.ok || !second.ok) throw new Error("create failed");
    expect(JSON.parse(first.text)).toMatchObject({ created: true, state: "queued", lane: "claude" });
    expect(JSON.parse(second.text)).toMatchObject({ created: false, task_id: (JSON.parse(first.text) as { task_id: string }).task_id });
    expect(fake.calls("p").map((c) => c.tool)).toEqual(["relay_task_requeue", "relay_task_create", "relay_task_create"]);
  });
});
