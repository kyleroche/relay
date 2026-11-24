/** The site's knock on the lead's door (lib/lead.ts): which board events send one, what it carries, and that a lead that is down costs nothing. */
import { describe, expect, it } from "vitest";
import { board, LEAD_WAKE_PATH, LEAD_WAKE_SIGNATURE_HEADER, LEAD_WAKE_TIMESTAMP_HEADER, parseLeadWake, verifyLeadWake } from "@relay/core";
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

const SECRET = "the-secret-the-site-shares-with-the-lead";

describe("waking the lead", () => {
  it("posts a task that reached review to the lead, signed with the shared secret and carrying no token, once, and nothing for any other event", async () => {
    const { events, trusted, id } = await reviewEvents();
    const sent: Array<{ url: string; headers: Headers; raw: string }> = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), raw: String(init?.body) });
      return new Response(JSON.stringify({ ok: true, sessionId: "s1", deliveryId: "d1" }), { status: 202, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const deps = { url: "https://lead.example", secret: SECRET, fetch: fetchFake };
    const results = [];
    for (const e of events) results.push(await wakeLeadFor(e, trusted, deps));
    expect(results.filter((r) => r.woke)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const { url, headers, raw } = sent[0]!;
    expect(url).toBe(`https://lead.example${LEAD_WAKE_PATH}`);
    // nothing that is a credential anywhere: no bearer, and never this deployment's Vercel identity
    expect([...headers.keys()].sort()).toEqual(["accept", "content-type", LEAD_WAKE_SIGNATURE_HEADER, LEAD_WAKE_TIMESTAMP_HEADER].sort());
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBeNull();
    // and the lead, holding the same secret, accepts exactly what was sent
    const signed = { timestamp: headers.get(LEAD_WAKE_TIMESTAMP_HEADER), signature: headers.get(LEAD_WAKE_SIGNATURE_HEADER), rawBody: raw };
    expect(verifyLeadWake({ secret: SECRET, ...signed })).toEqual({ ok: true });
    expect(verifyLeadWake({ secret: "some-other-secret-of-the-right-length", ...signed }).ok).toBe(false);
    const parsed = parseLeadWake(JSON.parse(raw));
    expect(parsed.ok && parsed.body).toMatchObject({ project: "demo", task: { id, title: "Add a greeting", lane: "claude", pr_url: "https://github.com/acme/demo/pull/7" }, event: { kind: "review" } });
  });

  it("does nothing without a lead, and a lead that is down is not an error", async () => {
    const { events, trusted } = await reviewEvents();
    const blocked = events.find((e) => e.type === "task.blocked")!;
    expect(await wakeLeadFor(blocked, trusted, { secret: SECRET })).toEqual({ woke: false });
    const down = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    expect((await wakeLeadFor(blocked, trusted, { url: "https://lead.example", secret: SECRET, fetch: down })).woke).toBe(false);
  });

  it("sends nothing without a secret it can sign with, and says why once", async () => {
    const { events, trusted } = await reviewEvents();
    const blocked = events.find((e) => e.type === "task.blocked")!;
    const said: string[] = [];
    let calls = 0;
    const counting = (async () => (calls++, new Response("{}", { status: 202 }))) as typeof fetch;
    const deps = { url: "https://lead.example", fetch: counting, log: (line: string) => said.push(line) };
    expect(await wakeLeadFor(blocked, trusted, { ...deps, secret: "" })).toEqual({ woke: false, why: "RELAY_LEAD_WAKE_SECRET is not set" });
    expect(await wakeLeadFor(blocked, trusted, { ...deps, secret: "too-short" })).toEqual({ woke: false, why: "RELAY_LEAD_WAKE_SECRET must be at least 32 characters" });
    expect(await wakeLeadFor(blocked, trusted, { ...deps, secret: "" })).toMatchObject({ woke: false });
    expect(calls).toBe(0);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/RELAY_LEAD_URL is set but RELAY_LEAD_WAKE_SECRET is not set, so no wake-up is sent/);
  });
});
