/** The site's knock on the lead's door (lib/lead.ts): which board events send one, what it carries, and that a lead that is down costs nothing. */
import { describe, expect, it } from "vitest";
import { board, LEAD_WAKE_PATH, parseLeadWake } from "@relay/core";
import { wakeLeadFor } from "../lib/lead.ts";

async function reviewEvents() {
  const b = await board.memoryBoard();
  const session = await board.connectBoard(b);
  const start = (await b.poll({ channel: board.WORK_SUBTREE, last: 1 })).cursor;
  const t = await board.openTask(b, { project: "demo", repo: "acme/demo", title: "Add a greeting", lane: "claude" });
  const claim = await b.as("relay-mini-claude").tasks.claim(t.id);
  await claim!.block("https://github.com/acme/demo/pull/7", { kind: board.HOLD.review });
  const events = (await b.poll({ channel: board.WORK_SUBTREE, after: start!, wait: 0 })).events;
  return { events, trusted: session.from, id: t.id };
}

describe("waking the lead", () => {
  it("posts a task that reached review to the lead with the deployment's token, once, and nothing for any other event", async () => {
    const { events, trusted, id } = await reviewEvents();
    const sent: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, sessionId: "s1", deliveryId: "d1" }), { status: 202, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const deps = { url: "https://lead.example", token: async () => "oidc-token", fetch: fetchFake };
    const results = [];
    for (const e of events) results.push(await wakeLeadFor(e, trusted, deps));
    expect(results.filter((r) => r.woke)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://lead.example${LEAD_WAKE_PATH}`);
    expect(sent[0]!.auth).toBe("Bearer oidc-token");
    const parsed = parseLeadWake(sent[0]!.body);
    expect(parsed.ok && parsed.body).toMatchObject({ project: "demo", task: { id, title: "Add a greeting", lane: "claude", pr_url: "https://github.com/acme/demo/pull/7" }, event: { kind: "review" } });
  });

  it("does nothing without a lead, and a lead that is down or a token that cannot be had is not an error", async () => {
    const { events, trusted } = await reviewEvents();
    const blocked = events.find((e) => e.type === "task.blocked")!;
    expect(await wakeLeadFor(blocked, trusted, { token: async () => "t" })).toEqual({ woke: false });
    const down = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    expect((await wakeLeadFor(blocked, trusted, { url: "https://lead.example", token: async () => "t", fetch: down })).woke).toBe(false);
    const noToken = await wakeLeadFor(blocked, trusted, { url: "https://lead.example", token: async () => Promise.reject(new Error("no OIDC token here")) });
    expect(noToken).toEqual({ woke: false, why: "no OIDC token here" });
  });
});
