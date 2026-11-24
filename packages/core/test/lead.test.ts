/** The site's call to relay's lead: the exact request, the idempotency key, and that a failure is a result, never a throw. */
import { describe, it, expect } from "vitest";
import { LEAD_WAKE_PATH, leadWakeKey, parseLeadWake, wakeLead, type LeadWake } from "../src/lead/client.ts";

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fetch that records what it was asked and answers as told. */
function fakeFetch(answer: () => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { fetch: f, seen };
}

const wake = (over: Partial<LeadWake> = {}): LeadWake => ({
  url: "https://lead.example.test",
  token: "oidc-token-for-the-test",
  project: "site",
  task: { id: "msg_01HZX", title: "Add dark mode", lane: "codex" },
  event: { kind: "failed", cursor: "c_000123", reason: "codex: rate limited" },
  ...over,
});

describe("wakeLead", () => {
  it("sends one POST to the wake route with the token twice, the body relay defines and a key made from the cursor", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true, sessionId: "wrun_A", deliveryId: "delivery_A" }, { status: 202 }));
    const r = await wakeLead(wake({ fetch }));

    expect(r).toEqual({ ok: true, status: 202, sessionId: "wrun_A", deliveryId: "delivery_A" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://lead.example.test${LEAD_WAKE_PATH}`);
    expect(seen[0]!.url).toBe("https://lead.example.test/relay/wake");
    const { init } = seen[0]!;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      authorization: "Bearer oidc-token-for-the-test",
      "x-vercel-trusted-oidc-idp-token": "oidc-token-for-the-test",
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      project: "site",
      task: { id: "msg_01HZX", title: "Add dark mode", lane: "codex" },
      event: { kind: "failed", cursor: "c_000123", reason: "codex: rate limited" },
      idempotencyKey: "relay-wake:c_000123",
    });
  });

  it("gives the same event the same key, and different events different ones", async () => {
    const keys: string[] = [];
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    for (const cursor of ["c_1", "c_1", "c_2"]) {
      await wakeLead(wake({ fetch, event: { kind: "review", cursor } }));
      keys.push((JSON.parse(String(seen.at(-1)!.init.body)) as { idempotencyKey: string }).idempotencyKey);
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("folds a cursor that would not fit a key into a digest of fixed length", () => {
    const long = "x".repeat(1500);
    expect(leadWakeKey(long)).toMatch(/^relay-wake:sha256:[0-9a-f]{64}$/);
    expect(leadWakeKey(long)).toBe(leadWakeKey(long));
    expect(leadWakeKey(long)).not.toBe(leadWakeKey(`${long}y`));
    expect(leadWakeKey("has a space")).toMatch(/^relay-wake:sha256:/);
    expect(leadWakeKey("c_1").length).toBeLessThanOrEqual(256);
  });

  it("keeps a path the lead is mounted under and drops a trailing slash", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    await wakeLead(wake({ fetch, url: "https://agents.example.test/lead/" }));
    expect(seen[0]!.url).toBe("https://agents.example.test/lead/relay/wake");
  });

  it("refuses before sending: plain http to another host, a URL with credentials, no token, a body that is not valid", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    const refused = [
      await wakeLead(wake({ fetch, url: "http://lead.example.test" })),
      await wakeLead(wake({ fetch, url: "https://user:pw@lead.example.test" })),
      await wakeLead(wake({ fetch, url: "not a url" })),
      await wakeLead(wake({ fetch, token: "" })),
      await wakeLead(wake({ fetch, project: "Not A Slug" })),
      await wakeLead(wake({ fetch, event: { kind: "exploded" as never, cursor: "c_1" } })),
      await wakeLead(wake({ fetch, event: { kind: "failed", cursor: "" } })),
    ];
    for (const r of refused) expect(r).toMatchObject({ ok: false, status: 0 });
    expect(seen).toHaveLength(0);
    // a local lead (eve dev) is the one place plain http is allowed
    expect(await wakeLead(wake({ fetch, url: "http://127.0.0.1:2000" }))).toMatchObject({ ok: true });
    expect(seen[0]!.url).toBe("http://127.0.0.1:2000/relay/wake");
  });

  it("returns a refusal and an unreachable lead as results, with the lead's own words when it gave any", async () => {
    const denied = fakeFetch(() => Response.json({ ok: false, code: "unauthorized", error: "Authorization is required for this route." }, { status: 401 }));
    expect(await wakeLead(wake({ fetch: denied.fetch }))).toEqual({ ok: false, status: 401, error: "Authorization is required for this route." });

    const html = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await wakeLead(wake({ fetch: html.fetch }))).toEqual({ ok: false, status: 502, error: "<html>bad gateway</html>" });

    const down = fakeFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await wakeLead(wake({ fetch: down.fetch }))).toEqual({ ok: false, status: 0, error: "the lead could not be reached: connect ECONNREFUSED" });
  });
});

describe("parseLeadWake", () => {
  const body = { project: "site", task: { id: "msg_1" }, event: { kind: "held", cursor: "c_9" }, idempotencyKey: "relay-wake:c_9" };

  it("accepts the smallest body and keeps only the fields relay defines", () => {
    expect(parseLeadWake(body)).toEqual({ ok: true, body });
    const extra = { ...body, session: "someone-else", task: { id: "msg_1", owner: "x" }, event: { ...body.event, actor: "y" } };
    expect(parseLeadWake(extra)).toEqual({ ok: true, body });
  });

  it("names what is wrong with a body it refuses", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["text", /JSON object/],
      [{ ...body, project: "../etc" }, /project/],
      [{ ...body, task: { id: "" } }, /task\.id/],
      [{ ...body, task: { id: "msg_1", lane: "Not A Lane" } }, /task\.lane/],
      [{ ...body, task: { id: "msg_1", pr_url: "javascript:alert(1)" } }, /task\.pr_url/],
      [{ ...body, event: { kind: "done", cursor: "c_9" } }, /event\.kind/],
      [{ ...body, event: { kind: "held", cursor: "c_9", reason: "r".repeat(2001) } }, /event\.reason/],
      [{ ...body, idempotencyKey: "k".repeat(257) }, /idempotencyKey/],
      [{ project: "site", task: { id: "msg_1" }, event: { kind: "held", cursor: "c_9" } }, /idempotencyKey/],
    ];
    for (const [input, message] of cases) {
      const r = parseLeadWake(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(message);
    }
  });
});
