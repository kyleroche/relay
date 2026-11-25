/** The site's call to relay's lead: the exact request and its signature, the idempotency key, and that a failure is a result, never a throw. */
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { LEAD_WAKE_PATH, leadWakeKey, leadWakeSecret, parseLeadWake, signLeadWake, verifyLeadWake, wakeLead, type LeadWake } from "../src/lead/client.ts";

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

const SECRET = "a-secret-shared-by-the-site-and-the-lead";
/** 2027-01-15T08:00:00Z, so the timestamp in the request is one a test can name. */
const NOW = 1_800_000_000_000;

const wake = (over: Partial<LeadWake> = {}): LeadWake => ({
  url: "https://lead.example.test",
  secret: SECRET,
  now: NOW,
  project: "site",
  task: { id: "msg_01HZX", title: "Add dark mode", lane: "codex" },
  event: { kind: "failed", cursor: "c_000123", reason: "codex: rate limited" },
  ...over,
});

describe("wakeLead", () => {
  it("sends one POST to the wake route: the body relay defines, a key made from the cursor, and a signature in place of any token", async () => {
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
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual({
      project: "site",
      task: { id: "msg_01HZX", title: "Add dark mode", lane: "codex" },
      event: { kind: "failed", cursor: "c_000123", reason: "codex: rate limited" },
      idempotencyKey: "relay-wake:c_000123",
    });
    // the whole of the headers: no authorization, no Vercel OIDC token, nothing that is a credential anywhere else
    expect(init.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-relay-wake-timestamp": "1800000000",
      // computed here by hand, so the wire format is pinned and not only self-consistent
      "x-relay-wake-signature": `sha256=${createHmac("sha256", SECRET).update(`1800000000.${body}`).digest("hex")}`,
    });
    expect(JSON.stringify(init)).not.toContain(SECRET);
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

  it("refuses before sending: plain http to another host, a URL with credentials, no secret or a short one, a body that is not valid", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    const refused = [
      await wakeLead(wake({ fetch, url: "http://lead.example.test" })),
      await wakeLead(wake({ fetch, url: "https://user:pw@lead.example.test" })),
      await wakeLead(wake({ fetch, url: "not a url" })),
      await wakeLead(wake({ fetch, secret: "" })),
      await wakeLead(wake({ fetch, secret: "x".repeat(31) })),
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

describe("the wake signature", () => {
  const raw = JSON.stringify({ project: "site", task: { id: "msg_1" }, event: { kind: "held", cursor: "c_9" }, idempotencyKey: "relay-wake:c_9" });
  const at = "1800000000";
  const signed = (over: Partial<Parameters<typeof verifyLeadWake>[0]> = {}) => verifyLeadWake({ secret: SECRET, timestamp: at, signature: signLeadWake(SECRET, at, raw), rawBody: raw, now: NOW, ...over });

  it("accepts what wakeLead sends, checked against the bytes that arrived", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    await wakeLead(wake({ fetch }));
    const headers = seen[0]!.init.headers as Record<string, string>;
    const sent = { timestamp: headers["x-relay-wake-timestamp"], signature: headers["x-relay-wake-signature"], rawBody: String(seen[0]!.init.body) };
    expect(verifyLeadWake({ secret: SECRET, ...sent, now: NOW })).toEqual({ ok: true });
    expect(verifyLeadWake({ secret: SECRET, ...sent, now: NOW + 299_000 })).toEqual({ ok: true });
    expect(signed()).toEqual({ ok: true });
  });

  it("refuses another secret, a changed body, a changed timestamp and a missing or malformed header", () => {
    const refused = [
      signed({ secret: "another-secret-of-the-right-length-x" }),
      signed({ rawBody: raw.replace("msg_1", "msg_2") }),
      signed({ rawBody: `${raw} ` }),
      // the timestamp is part of what is signed, so a fresh one cannot be put on an old signature
      signed({ timestamp: "1800000001" }),
      signed({ signature: signLeadWake(SECRET, at, raw).toUpperCase() }),
      signed({ signature: signLeadWake(SECRET, at, raw).slice(0, -2) }),
      signed({ signature: "" }),
      signed({ signature: null }),
      signed({ timestamp: null }),
      signed({ timestamp: "2027-01-15T08:00:00Z" }),
    ];
    for (const r of refused) expect(r.ok).toBe(false);
    expect(signed({ rawBody: raw.replace("msg_1", "msg_2") })).toEqual({ ok: false, error: "the signature does not match" });
  });

  it("refuses a good signature more than five minutes from the verifier's clock, and says so only then", () => {
    expect(signed({ now: NOW + 300_000 })).toEqual({ ok: true });
    expect(signed({ now: NOW - 300_000 })).toEqual({ ok: true });
    for (const now of [NOW + 301_000, NOW - 301_000, NOW + 86_400_000]) expect(signed({ now })).toEqual({ ok: false, error: "the timestamp is more than 5 minutes from this clock" });
    // a stale request signed with the wrong secret learns nothing about the clock
    expect(signed({ now: NOW + 86_400_000, secret: "another-secret-of-the-right-length-x" })).toEqual({ ok: false, error: "the signature does not match" });
  });

  it("takes a secret of 32 characters or more, trimmed, and names the variable when there is none", () => {
    expect(leadWakeSecret(undefined)).toEqual({ ok: false, error: "RELAY_LEAD_WAKE_SECRET is not set" });
    expect(leadWakeSecret("   ")).toEqual({ ok: false, error: "RELAY_LEAD_WAKE_SECRET is not set" });
    expect(leadWakeSecret("x".repeat(31))).toEqual({ ok: false, error: "RELAY_LEAD_WAKE_SECRET must be at least 32 characters" });
    expect(leadWakeSecret(` ${"x".repeat(32)}\n`)).toEqual({ ok: true, secret: "x".repeat(32) });
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
