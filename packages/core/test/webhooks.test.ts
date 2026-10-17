import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { isLoopbackHost, isPrivateHost, validateWebhookUrl } from "../src/db/webhooks.ts";
import { deliverWebhook, dispatchEvent, pingPayload, signWebhook, verifyWebhookSignature, webhookPayload, type FetchLike } from "../src/webhooks/dispatch.ts";

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
  await repo.upsertProject(db, { slug: "other", repo: "acme/other", path: "/tmp/other" });
});
afterAll(async () => {
  await db.close();
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers from a script of statuses (or throws on "ECONNRESET"). */
function scripted(script: Array<number | "ECONNRESET">): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const next = script.shift() ?? 200;
    if (next === "ECONNRESET") throw new Error("ECONNRESET");
    return { ok: next >= 200 && next < 300, status: next };
  };
  return { fetch, calls };
}

describe("webhook targets", () => {
  it("accepts public https only; http is for loopback outside production", () => {
    expect(validateWebhookUrl("https://bot.example/relay", "production")).toBeUndefined();
    expect(validateWebhookUrl("https://bot.example:8443/relay", "development")).toBeUndefined();
    expect(validateWebhookUrl("http://bot.example/relay", "development")).toMatch(/https/);
    expect(validateWebhookUrl("http://bot.example/relay", "production")).toMatch(/https/);
    expect(validateWebhookUrl("http://localhost:3000/hook", "development")).toBeUndefined();
    expect(validateWebhookUrl("http://127.0.0.1:3000/hook", undefined)).toBeUndefined();
    expect(validateWebhookUrl("http://localhost:3000/hook", "production")).toMatch(/loopback/);
    expect(validateWebhookUrl("https://127.0.0.1/hook", "production")).toMatch(/loopback/);
    expect(validateWebhookUrl("ftp://bot.example/x", "development")).toMatch(/https/);
    expect(validateWebhookUrl("not a url", "development")).toMatch(/absolute/);
  });

  it("refuses link-local, RFC 1918, unique-local and internal names in every environment", () => {
    for (const host of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "169.254.169.254", "100.64.0.1", "[fe80::1]", "[fd00::1]", "[::ffff:10.0.0.1]", "metadata.internal", "printer.local", "db.corp.INTERNAL"]) {
      expect(validateWebhookUrl(`https://${host}/hook`, "development"), host).toMatch(/private or internal/);
      expect(validateWebhookUrl(`https://${host}/hook`, "production"), host).toMatch(/private or internal/);
    }
    for (const host of ["172.32.0.1", "11.0.0.1", "192.169.0.1", "bot.example", "internal.example.com", "local.example.com"]) expect(validateWebhookUrl(`https://${host}/hook`, "production"), host).toBeUndefined();
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("app.localhost")).toBe(true);
    expect(isPrivateHost("::1")).toBe(false);
  });

  it("createWebhook refuses a private target", async () => {
    await expect(repo.createWebhook(db, { url: "https://192.168.0.10/hook", events: ["*"], createdBy: "t" })).rejects.toThrow(/private or internal/);
  });
});

describe("webhook signature", () => {
  it("signs <ts>.<body> with HMAC-SHA256 and verifies within the tolerance", () => {
    const sig = signWebhook("s3cret", "1700000000", '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("s3cret", "1700000000", '{"a":1}', sig, { now: 1_700_000_010_000 })).toBe(true);
    expect(verifyWebhookSignature("s3cret", "1700000000", '{"a":2}', sig, { now: 1_700_000_010_000 })).toBe(false);
    expect(verifyWebhookSignature("other", "1700000000", '{"a":1}', sig, { now: 1_700_000_010_000 })).toBe(false);
    expect(verifyWebhookSignature("s3cret", "1700000000", '{"a":1}', sig, { now: 1_700_001_000_000 })).toBe(false); // replayed 1000 s later
    expect(verifyWebhookSignature("s3cret", undefined, '{"a":1}', sig)).toBe(false);
  });
});

describe("delivery", () => {
  it("sends the documented headers and payload, records the delivery, and retries with backoff", async () => {
    const hook = await repo.createWebhook(db, { project: "demo", url: "https://bot.example/relay", events: ["pr.merged", "run."], bearer: "bk_123", createdBy: "human:kyle" });
    expect(hook.secret).toMatch(/^whsec_/);
    const event = (await repo.writeEvent(db, { kind: "pr.merged", actor: "human:kyle", project: "demo", repo: "acme/demo", issue: 42, pr: 7, url: "https://github.com/acme/demo/pull/7", summary: "Merged #7" }))!;

    const { fetch, calls } = scripted([500, "ECONNRESET", 200]);
    const r = await deliverWebhook(hook, webhookPayload(event, "D1"), { fetch, db, backoffMs: [1, 1], now: () => 1_700_000_000_000 });
    expect(r).toMatchObject({ status: "delivered", attempts: 3, last_status: 200, error: null, delivery_id: "D1" });
    expect(calls.length).toBe(3);

    const c = calls[2]!;
    expect(c.url).toBe("https://bot.example/relay");
    expect(c.headers.authorization).toBe("Bearer bk_123");
    expect(c.headers["x-relay-event"]).toBe("pr.merged");
    expect(c.headers["x-relay-delivery"]).toBe("D1");
    expect(c.headers["x-relay-timestamp"]).toBe("1700000000");
    expect(verifyWebhookSignature(hook.secret, c.headers["x-relay-timestamp"], c.body, c.headers["x-relay-signature"], { now: 1_700_000_000_000 })).toBe(true);
    const body = JSON.parse(c.body) as Record<string, unknown>;
    expect(body).toMatchObject({ id: "D1", kind: "pr.merged", ts: event.ts, task_id: "acme/demo#42", project: "demo", issue: 42, pr: 7, url: "https://github.com/acme/demo/pull/7", summary: "Merged #7", actor: "human:kyle", event_id: event.id });

    const deliveries = await repo.listDeliveries(db, hook.id);
    expect(deliveries[0]).toMatchObject({ id: "D1", status: "delivered", attempts: 3, event_id: event.id, kind: "pr.merged" });
    expect(deliveries[0]?.delivered_at).toBeTruthy();
  });

  it("gives up after three attempts and records the failure; 4xx stops early", async () => {
    const hook = await repo.createWebhook(db, { url: "https://down.example/", events: ["*"], createdBy: "human:kyle" });
    const event = (await repo.writeEvent(db, { kind: "run.failed", actor: "runner:mini", project: "demo", repo: "acme/demo", issue: 1, summary: "boom" }))!;
    const down = scripted([503, 503, 503, 503]);
    const r = await deliverWebhook(hook, webhookPayload(event, "D2"), { fetch: down.fetch, db, backoffMs: [1, 1] });
    expect(r).toMatchObject({ status: "failed", attempts: 3, last_status: 503, error: "HTTP 503" });
    expect(down.calls.length).toBe(3);
    expect((await repo.listDeliveries(db, hook.id))[0]).toMatchObject({ status: "failed", attempts: 3, last_error: "HTTP 503" });

    const gone = scripted([404, 200]);
    const r2 = await deliverWebhook(hook, webhookPayload(event, "D3"), { fetch: gone.fetch, db, backoffMs: [1, 1] });
    expect(r2).toMatchObject({ status: "failed", attempts: 1, last_status: 404 });
    expect(gone.calls.length).toBe(1);
    await repo.deleteWebhook(db, hook.id);
  });

  it("dispatchEvent fans out only to matching hooks: project filter, exact kind, prefix and *", async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url) => {
      seen.push(url);
      return { ok: true, status: 200 };
    };
    const global = await repo.createWebhook(db, { url: "https://g.example/", events: ["*"], createdBy: "t" });
    const otherOnly = await repo.createWebhook(db, { project: "other", url: "https://o.example/", events: ["pr.merged"], createdBy: "t" });
    const assets = await repo.createWebhook(db, { project: "demo", url: "https://a.example/", events: ["asset."], createdBy: "t" });

    const merged = (await repo.writeEvent(db, { kind: "pr.merged", actor: "human:kyle", project: "demo", repo: "acme/demo", issue: 9, pr: 10, summary: "m" }))!;
    const r1 = await dispatchEvent(db, merged, { fetch, backoffMs: [] });
    expect(r1.map((x) => x.webhook_id).sort()).toEqual([...(await repo.listWebhooks(db, { project: "demo" })).filter((h) => h.events.includes("*") || h.events.includes("pr.merged")).map((h) => h.id)].sort());
    expect(seen).toContain("https://g.example/");
    expect(seen).not.toContain("https://o.example/");
    expect(seen).not.toContain("https://a.example/");

    seen.length = 0;
    const uploaded = (await repo.writeEvent(db, { kind: "asset.uploaded", actor: "bot:grok", project: "demo", summary: "u" }))!;
    await dispatchEvent(db, uploaded, { fetch, backoffMs: [] });
    expect(seen.sort()).toEqual(["https://a.example/", "https://g.example/"].concat(seen.filter((u) => u.includes("bot.example"))).sort());

    seen.length = 0;
    const noProject = (await repo.writeEvent(db, { kind: "external.note", actor: "bot:x", summary: "n" }))!;
    await dispatchEvent(db, noProject, { fetch, backoffMs: [] });
    expect(seen).toEqual(["https://g.example/"]); // only global hooks see project-less events

    for (const h of [global, otherOnly, assets]) await repo.deleteWebhook(db, h.id);
  });

  it("test.ping carries the hook's project and is signed like any event", async () => {
    const hook = await repo.createWebhook(db, { project: "demo", url: "https://p.example/", events: ["pr.merged"], createdBy: "t" });
    const { fetch, calls } = scripted([200]);
    const r = await deliverWebhook(hook, pingPayload(hook, "P1"), { fetch, db, backoffMs: [] });
    expect(r.status).toBe("delivered");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ id: "P1", kind: "test.ping", project: "demo", actor: "bot:relay" });
    expect(calls[0]!.headers["x-relay-event"]).toBe("test.ping");
    expect((await repo.listDeliveries(db, hook.id))[0]).toMatchObject({ event_id: null, kind: "test.ping", status: "delivered" });
    expect(repo.publicWebhook(hook)).not.toHaveProperty("secret");
    expect(repo.publicWebhook(hook).has_bearer).toBe(false);
  });
});
